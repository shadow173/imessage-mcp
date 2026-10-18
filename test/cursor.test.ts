import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { decodeCursor, encodeCursor, offsetCursor } from '../src/lib/cursor.js';
import { ToolError } from '../src/lib/errors.js';
import { LiveStore } from '../src/live/liveStore.js';
import { UpCursor } from '../src/tools/read/getUpdates.js';
import { appleNs, createAddressBook, createChatDb, fixtureBridgeConfig } from './helpers/chatdb.js';
import { makeCtx } from './helpers/ctx.js';
import { connectTools, errCode, text } from './helpers/mcp.js';
import { encodeAttributedBody as body } from './helpers/typedstream.js';
import { waitFor } from './helpers/wait.js';

// Cursors come back from the agent, which may have read them from (or been told them by) a message. Before cursors
// were schema-checked, a SQL fragment in the offset reached chat.db, past HIDE.
const SQL = '0) union select text from message --';

const toolError = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  assert.fail('expected a ToolError');
};
const raw = (json: string) => `c_${Buffer.from(json).toString('base64url')}`;

describe('decodeCursor refuses forged cursors', () => {
  const SM = offsetCursor('sm');
  const forged: [string, string][] = [
    ['a SQL fragment as the offset', encodeCursor({ k: 'sm', o: SQL })],
    ['a numeric string as the offset', encodeCursor({ k: 'sm', o: '5' })],
    ['no offset', encodeCursor({ k: 'sm' })],
    ['a negative offset', encodeCursor({ k: 'sm', o: -1 })],
    ['a fractional offset', encodeCursor({ k: 'sm', o: 1.5 })],
    ['an offset past the cap', encodeCursor({ k: 'sm', o: 2_000_000 })],
    ['another tool', encodeCursor({ k: 'la', o: 5 })],
    ['a hash with SQL in it', encodeCursor({ k: 'sm', o: 0, h: "x' or '1'='1" })],
    ['a non-numeric as_of', encodeCursor({ k: 'sm', o: 0, as_of: 'now' })],
    ['JSON that is not an object', raw('[1,2]')],
    ['JSON null', raw('null')],
    ['broken JSON', raw('{"k":"sm","o":')],
    ['no c_ prefix', Buffer.from('{"k":"sm","o":0}').toString('base64url')],
    ['a message id', 'm1234'],
  ];
  for (const [what, cursor] of forged)
    it(`refuses ${what}`, () => {
      const e = toolError(() => decodeCursor(cursor, SM));
      assert.equal(e.code, 'invalid_cursor');
      assert.equal(e.fix, 'Pass the cursor exactly as the same tool returned it, or omit it to start over.');
    });

  it('accepts real cursors, including old ones minted before the hash, and drops unknown fields', () => {
    assert.deepEqual(decodeCursor(encodeCursor({ k: 'sm', o: 50, h: 'AbC-_12345', as_of: 1.5e12 }), SM), {
      k: 'sm',
      o: 50,
      h: 'AbC-_12345',
      as_of: 1.5e12,
    });
    assert.deepEqual(decodeCursor(encodeCursor({ k: 'sm', o: 0, sql: SQL }), SM), { k: 'sm', o: 0 });
  });

  it('refuses a get_updates cursor whose sequence is not a whole number', () => {
    for (const s of ['1 or 1=1', -1, 0.5, null])
      assert.equal(toolError(() => decodeCursor(encodeCursor({ k: 'up', s }), UpCursor)).code, 'invalid_cursor');
    assert.equal(decodeCursor(encodeCursor({ k: 'up', s: 7 }), UpCursor).s, 7);
  });
});

describe('every paging tool refuses a forged cursor', () => {
  // [tool, arguments besides the cursor, a forged cursor for it]
  const CASES: [string, Record<string, unknown>, string][] = [
    ['search_messages', { query: 'cabin' }, encodeCursor({ k: 'sm', o: SQL })],
    ['list_conversations', {}, encodeCursor({ k: 'lc', o: SQL })],
    ['list_conversations', {}, encodeCursor({ k: 'lc', o: 0, s: 'recent', r: 9, t: 'x' })],
    ['read_conversation', { chat: 'Mom' }, encodeCursor({ k: 'rc', chat: 'x', dir: 'sideways', t: SQL, id: 'm1' })],
    ['get_reply_thread', { message_id: 'm1681' }, encodeCursor({ k: 'rt', o: SQL })],
    ['get_updates', {}, encodeCursor({ k: 'up', s: SQL })],
    ['list_attachments', {}, encodeCursor({ k: 'la', o: -1 })],
    ['list_links', {}, encodeCursor({ k: 'll', o: SQL })],
  ];
  for (const [tool, args, cursor] of CASES)
    it(`${tool} answers invalid_cursor and runs nothing`, async () => {
      const { call } = await connectTools(makeCtx());
      const r = await call(tool, { ...args, cursor });
      assert.equal(errCode(r), 'invalid_cursor', text(r));
      assert.doesNotMatch(text(r), /union select/);
    });

  it("refuses one tool's real cursor in another", async () => {
    const { call } = await connectTools(makeCtx());
    const page = await call('search_messages', { query: 'cabin', limit: 1, format: 'json' });
    const cursor = page.structuredContent.next_cursor as string;
    assert.match(cursor, /^c_/);
    assert.equal(errCode(await call('list_attachments', { cursor })), 'invalid_cursor');
    assert.equal(errCode(await call('search_messages', { query: 'cabin', cursor })), undefined);
  });
});

describe('the live store binds LIMIT and OFFSET', () => {
  let dir: string;
  let store: LiveStore;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'imsg-cursor-'));
    const db = createChatDb(join(dir, 'chat.db'));
    createAddressBook(dir, [{ first: 'Sam', last: 'Ortiz', phones: ['(555) 555-0142'] }]);
    db.prepare("insert into handle (ROWID, id, service) values (1, '+15555550142', 'iMessage')").run();
    db.prepare(
      "insert into chat (ROWID, guid, style, chat_identifier, service_name) values (1, 'any;-;+15555550142', 45, '+15555550142', 'iMessage')",
    ).run();
    db.prepare('insert into chat_handle_join (chat_id, handle_id) values (1, 1)').run();
    const t0 = Date.parse('2026-10-01T16:00:00Z');
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        "insert into message (ROWID, guid, attributedBody, handle_id, service, date) values (?, ?, ?, 1, 'iMessage', ?)",
      ).run(i, `G-${i}`, body(`cabin note ${i}`), appleNs(t0 + i * 60_000));
      db.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (1, ?, ?)').run(
        i,
        appleNs(t0 + i * 60_000),
      );
    }
    db.close();
    store = new LiveStore(fixtureBridgeConfig(dir));
    store.start();
    await waitFor(() => store.indexStatus().ready, 'the search index to build');
  });
  after(() => {
    store?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pages normally with whole numbers', () => {
    const page = store.listMessages({}, { order: 'desc', limit: 2, offset: 1 });
    assert.deepEqual(
      page.items.map((m) => m.text),
      ['cabin note 2', 'cabin note 1'],
    );
    assert.equal(store.search({ text: 'cabin' }, { sort: 'newest', limit: 5, offset: 0 }).total, 3);
  });

  it('refuses anything else as invalid_argument before any SQL runs', () => {
    // Typed as numbers, but a store method can still be handed whatever a caller parsed.
    const bad = [SQL, '1', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY] as unknown as number[];
    for (const v of bad) {
      for (const [what, run] of [
        ['listMessages offset', () => store.listMessages({}, { order: 'desc', limit: 5, offset: v })],
        ['listMessages limit', () => store.listMessages({}, { order: 'desc', limit: v, offset: 0 })],
        ['search offset', () => store.search({ text: 'cabin' }, { sort: 'newest', limit: 5, offset: v })],
        ['listAttachments offset', () => store.listAttachments({}, { limit: 5, offset: v })],
      ] as const)
        assert.equal(toolError(run).code, 'invalid_argument', `${what} = ${String(v)}`);
    }
  });
});
