import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { ToolError } from '../src/lib/errors.js';
import { LiveStore } from '../src/live/liveStore.js';
import { createSender, type ScriptRunner } from '../src/live/sender.js';
import { Sidecar } from '../src/live/sidecar.js';
import { sendFingerprint } from '../src/store/idempotency.js';
import { appleNs, createAddressBook, createChatDb, fixtureBridgeConfig } from './helpers/chatdb.js';
import { captureConsole } from './helpers/console.js';
import { toolConfig } from './helpers/ctx.js';
import { connectTools, text } from './helpers/mcp.js';
import { encodeAttributedBody as body } from './helpers/typedstream.js';
import { waitFor } from './helpers/wait.js';

// The bridge runs unattended for weeks. A crash mid-send, a failed index build or a bad directory reload must leave it
// serving, and must never turn into a second copy of a message.
const SAM = { chatId: 'any;-;+15555550142' };
const code = (c: string) => (e: unknown) => e instanceof ToolError && e.code === c;

/** A fixture under a new temp dir: Sam's 1:1 with one message. Returns the dir. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imsg-resilience-'));
  createAddressBook(dir, [{ first: 'Sam', last: 'Ortiz', phones: ['(555) 555-0142'] }]);
  const db = createChatDb(join(dir, 'chat.db'));
  db.prepare("insert into handle (ROWID, id, service) values (1, '+15555550142', 'iMessage')").run();
  db.prepare(
    "insert into chat (ROWID, guid, style, chat_identifier, service_name) values (1, 'any;-;+15555550142', 45, '+15555550142', 'iMessage')",
  ).run();
  db.prepare('insert into chat_handle_join (chat_id, handle_id) values (1, 1)').run();
  const at = appleNs(Date.now() - 3_600_000);
  db.prepare(
    "insert into message (ROWID, guid, attributedBody, handle_id, service, date) values (1, 'G-1', ?, 1, 'iMessage', ?)",
  ).run(body('are we still on?'), at);
  db.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (1, 1, ?)').run(at);
  db.close();
  return dir;
}

/** Plays Messages for the sender: each send writes its row into chat.db. Counts the sends. */
function fakeMessages(chatDb: string) {
  const state = { runs: 0 };
  const run: ScriptRunner = async (_script, args) => {
    state.runs++;
    const w = new DatabaseSync(chatDb);
    try {
      const row = Number((w.prepare('select coalesce(max(ROWID), 0) r from message').get() as { r: number }).r) + 1;
      w.prepare(
        "insert into message (ROWID, guid, attributedBody, handle_id, is_from_me, service, date, is_sent, is_delivered) values (?, ?, ?, 1, 1, 'iMessage', ?, 1, 1)",
      ).run(row, `S-${row}`, body(args[0]), appleNs(Date.now()));
      w.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (1, ?, ?)').run(
        row,
        appleNs(Date.now()),
      );
    } finally {
      w.close();
    }
  };
  return { run, state };
}

describe('sidecar migrations', () => {
  it('upgrades a sidecar from before schema versions, and pruning never drops a pending send', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imsg-sidecar-'));
    try {
      const old = new DatabaseSync(join(dir, 'sidecar.db'));
      old.exec(`
        CREATE TABLE reminders (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL UNIQUE, remind_at INTEGER NOT NULL, note TEXT, dismiss_on_reply INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE drafts (id TEXT PRIMARY KEY, chat_id TEXT, to_address TEXT, text TEXT NOT NULL, send_at INTEGER, note TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, sent_message_id TEXT);
        INSERT INTO reminders VALUES ('r0', 'a', 1, NULL, 0, 1), ('r1', 'b', 1, NULL, 1, 1), ('r2', 'c', 1, NULL, 2, 1);`);
      old.close();
      const side = new Sidecar(dir);
      const get = <T>(sql: string) => side.db.prepare(sql).all() as T[];
      assert.equal(get<{ user_version: number }>('PRAGMA user_version')[0].user_version, 3);
      assert.deepEqual(
        get<{ w: string }>('select dismiss_when w from reminders order by id').map((r) => r.w),
        ['never', 'they_reply', 'i_reply'],
      );
      const cols = get<{ name: string }>('pragma table_info(drafts)').map((c) => c.name);
      assert.ok(cols.includes('sending_boot') && cols.includes('attachments'), cols.join(','));
      side.db
        .prepare('insert into idempotency values (?, ?, ?), (?, ?, ?)')
        .run('done-key', '{"disposition":"delivered"}', 1, 'pending-key', '{"pending":true,"boot":"x"}', 1);
      side.prune();
      assert.deepEqual(
        get<{ key: string }>('select key from idempotency').map((r) => r.key),
        ['pending-key'],
      );
      side.db.close();
      const again = new Sidecar(dir);
      assert.equal((again.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
      again.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sends interrupted by a crash', () => {
  let dir: string;
  let store: LiveStore;
  let messages: ReturnType<typeof fakeMessages>;
  let send: ReturnType<typeof createSender>;
  const fp = (t: string) => sendFingerprint(store, SAM, t, [], {});
  const pending = (key: string, boot: string, text: string) =>
    store.side.db
      .prepare('insert into idempotency values (?, ?, ?)')
      .run(key, JSON.stringify({ pending: true, boot, startedAt: 1, chatId: SAM.chatId, fp: fp(text) }), Date.now());

  before(() => {
    dir = fixture();
    // A draft the previous run was sending when it died.
    mkdirSync(join(dir, 'data'));
    const side = new Sidecar(join(dir, 'data'));
    side.db
      .prepare(
        "insert into drafts (id, chat_id, text, status, created_at, sending_boot) values ('d-crash', ?, 'hi', 'scheduled', 1, 'deadbeef')",
      )
      .run(SAM.chatId);
    side.db.close();
    const cfg = fixtureBridgeConfig(dir);
    store = new LiveStore(cfg);
    store.start();
    messages = fakeMessages(cfg.chatDbPath);
    send = createSender(store, cfg, messages.run, 1500);
  });
  after(() => {
    store?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks a draft that was mid-send as failed: outcome_unknown, without sending it again', () => {
    const d = store.drafts().find((x) => x.draftId === 'd-crash')!;
    assert.deepEqual([d.status, d.error], ['failed', 'outcome_unknown']);
    assert.equal(messages.state.runs, 0);
  });

  it('answers a key left pending by an earlier run with may_have_completed, once, and never re-sends', async () => {
    pending('crashed-key-1', 'otherboot', 'hello there');
    const r = await send(SAM, 'hello there', [], 'auto', 'crashed-key-1');
    assert.deepEqual([r.disposition, r.replayed, r.error?.code], ['may_have_completed', true, 'outcome_unknown']);
    const again = await send(SAM, 'hello there', [], 'auto', 'crashed-key-1');
    assert.equal(again.disposition, 'may_have_completed');
    assert.equal(messages.state.runs, 0);
    await assert.rejects(send(SAM, 'other text', [], 'auto', 'crashed-key-1'), code('idempotency_conflict'));
  });

  it('refuses a key that this run is still sending', async () => {
    pending('running-key-1', store.bootId, 'hello there');
    assert.equal(store.idempotencyLookup('running-key-1'), 'in_progress');
    await assert.rejects(send(SAM, 'hello there', [], 'auto', 'running-key-1'), code('in_progress'));
    assert.equal(messages.state.runs, 0);
  });

  it('leaves no pending key when nothing was sent, and runs parallel sends one at a time', async () => {
    const file = { filename: 'a.png', mime: 'image/png', sourceAttachmentId: 'a999' };
    await assert.rejects(send(SAM, 'x', [file], 'auto', 'stage-fail-1'), code('attachment_not_found'));
    assert.equal(store.side.db.prepare("select 1 from idempotency where key = 'stage-fail-1'").get(), undefined);
    const [a, b] = await Promise.all([
      send(SAM, 'first one', [], 'auto', 'parallel-key-1'),
      send(SAM, 'second one', [], 'auto', 'parallel-key-2'),
    ]);
    assert.deepEqual(
      [a.disposition, a.message?.text, b.disposition, b.message?.text],
      ['delivered', 'first one', 'delivered', 'second one'],
    );
    assert.equal(messages.state.runs, 2);
  });
});

describe('a failing piece leaves the store serving', () => {
  it('a failed index build is reported as index_failed, not "building" forever, and nothing crashes', async () => {
    const dir = fixture();
    const cfg = fixtureBridgeConfig(dir);
    const store = new LiveStore(cfg);
    try {
      (store as unknown as { index: { build: () => Promise<void> } }).index.build = async () => {
        throw new Error('database or disk is full');
      };
      const { lines } = await captureConsole(async () => {
        store.start();
        await waitFor(() => store.indexStatus().error !== undefined, 'the index error to be recorded');
      });
      assert.match(lines.join('\n'), /search index build failed/);
      assert.equal(store.indexStatus().error, 'database or disk is full');
      assert.throws(
        () => store.search({ text: 'still' }, { sort: 'newest', limit: 5, offset: 0 }),
        code('index_failed'),
      );
      const { call } = await connectTools({
        store,
        cfg: toolConfig(),
        baseUrl: '',
        sendLog: [],
        scopes: new Set(['messages.read']),
        resourceMetadataUrl: '',
      });
      assert.match(text(await call('search_messages', { query: 'still' })), /^Error index_failed: /);
      assert.equal(store.health().search_index, 'failed: database or disk is full');
      assert.equal(store.pageChat(SAM.chatId, {}, { limit: 5, anchor: 'end' }).total, 1, 'reading still works');
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a directory reload that fails part way keeps the previous people and chats', () => {
    const dir = fixture();
    const store = new LiveStore(fixtureBridgeConfig(dir));
    try {
      store.start();
      const before = { people: store.people().map((p) => p.name), chats: store.chats().map((c) => c.chatId) };
      const w = new DatabaseSync(join(dir, 'chat.db'));
      w.exec('ALTER TABLE handle RENAME TO handle_moved');
      try {
        assert.throws(() => store.refreshDirectory(), /handle/);
      } finally {
        w.exec('ALTER TABLE handle_moved RENAME TO handle');
        w.close();
      }
      assert.deepEqual(
        { people: store.people().map((p) => p.name), chats: store.chats().map((c) => c.chatId) },
        before,
      );
      assert.ok(store.chat(SAM.chatId));
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('housekeeping removes week-old staged folders unless chat.db still points into them', () => {
    const dir = fixture();
    const stage = join(dir, 'stage');
    for (const n of ['in-use', 'abandoned', 'fresh']) {
      mkdirSync(join(stage, n), { recursive: true });
      writeFileSync(join(stage, n, 'f.png'), 'x');
    }
    const weekAgo = (Date.now() - 8 * 86_400_000) / 1000;
    const now = Date.now() / 1000;
    utimesSync(join(stage, 'in-use'), weekAgo, weekAgo);
    utimesSync(join(stage, 'abandoned'), weekAgo, weekAgo);
    utimesSync(join(stage, 'fresh'), now, now);
    const w = new DatabaseSync(join(dir, 'chat.db'));
    w.prepare(
      "insert into attachment (ROWID, guid, original_guid, filename, transfer_name, total_bytes) values (1, 'A', 'A', ?, 'f.png', 1)",
    ).run(join(stage, 'IN-USE', 'f.png'));
    w.close();
    const store = new LiveStore(fixtureBridgeConfig(dir));
    try {
      store.start();
      assert.deepEqual(
        ['in-use', 'abandoned', 'fresh'].map((n) => existsSync(join(stage, n))),
        [true, false, true],
      );
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
