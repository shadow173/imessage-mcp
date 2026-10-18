import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ALL_SCOPES } from '../src/auth/scopes.js';
import { encodeCursor } from '../src/lib/cursor.js';
import { LiveStore } from '../src/live/liveStore.js';
import { buildServer } from '../src/server.js';
import { PLIST } from './fixtures/blobs.js';
import { appleNs, createAddressBook, createChatDb, fixtureBridgeConfig } from './helpers/chatdb.js';
import { connect, type Result, text } from './helpers/mcp.js';
import { encodeAttributedBody as body } from './helpers/typedstream.js';
import { waitFor } from './helpers/wait.js';

// HIDE removes people and chats from everything the agent can reach. Each hidden chat below holds a unique word, and
// every read-only tool is called with arguments aimed at them; none of the words, names or numbers may come back.
const HIDE = ['linda carter', 'Riley@Example.com', '(555) 555-0122', 'iMessage;+;chat777'];
const FORBIDDEN = [
  'quartzlinda',
  'quartzriley',
  'quartzbook',
  'quartzplans',
  'Linda',
  'Carter',
  'Riley',
  'riley@',
  'Quinn',
  '5550111',
  '555-0111',
  '5550122',
  '555-0122',
  'chat500',
  'chat777',
  'Book Club',
  'Secret Plans',
  'IMG_SECRET',
  'secret.example',
];

let dir: string;
let chatDb: string;
let store: LiveStore;
let client: Client;
let rowid = 0;
const ids: Record<string, string> = {};
const T0 = Date.now() - 3 * 86_400_000;

/** Inserts one message (and its chat link) and returns its message id. */
function add(
  db: DatabaseSync,
  chat: number,
  handle: number,
  minute: number,
  words: string,
  o: Record<string, unknown> = {},
) {
  rowid++;
  const at = appleNs(T0 + minute * 60_000);
  db.prepare(
    `insert into message (ROWID, guid, attributedBody, handle_id, is_from_me, service, date, is_read, thread_originator_guid,
      cache_has_attachments, balloon_bundle_id, payload_data) values (?, ?, ?, ?, ?, 'iMessage', ?, 0, ?, ?, ?, ?)`,
  ).run(
    rowid,
    `G-${rowid}`,
    body(words),
    handle,
    handle === 0 ? 1 : 0,
    at,
    (o.thread as string) ?? null,
    o.att ? 1 : 0,
    (o.balloon as string) ?? null,
    (o.payload as Buffer) ?? null,
  );
  db.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (?, ?, ?)').run(chat, rowid, at);
  return `m${rowid}`;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'imsg-hide-'));
  chatDb = join(dir, 'chat.db');
  createAddressBook(dir, [
    { first: 'Sam', last: 'Ortiz', phones: ['(555) 555-0142'] },
    { first: 'Linda', last: 'Carter', nickname: 'Mom', phones: ['555-555-0111'] },
    { first: 'Riley', last: 'Park', emails: ['riley@example.com'] },
    { first: 'Pat', last: 'Quinn', phones: ['+1 555 555 0122'] },
  ]);
  const db = createChatDb(chatDb);
  const handle = db.prepare('insert into handle (ROWID, id, service) values (?, ?, ?)');
  handle.run(1, '+15555550142', 'iMessage');
  handle.run(2, '+15555550111', 'iMessage');
  handle.run(3, 'riley@example.com', 'iMessage');
  handle.run(4, '+15555550122', 'iMessage');
  handle.run(5, '+15555550199', 'SMS');
  const chat = db.prepare(
    'insert into chat (ROWID, guid, style, chat_identifier, service_name, display_name) values (?, ?, ?, ?, ?, ?)',
  );
  chat.run(1, 'any;-;+15555550142', 45, '+15555550142', 'iMessage', null);
  chat.run(2, 'any;-;+15555550111', 45, '+15555550111', 'iMessage', null);
  chat.run(3, 'any;-;riley@example.com', 45, 'riley@example.com', 'iMessage', null);
  chat.run(4, 'any;+;chat500', 43, 'chat500', 'iMessage', 'Book Club');
  chat.run(5, 'any;+;chat777', 43, 'chat777', 'iMessage', 'Secret Plans');
  chat.run(6, 'any;-;+15555550199', 45, '+15555550199', 'SMS', null);
  const member = db.prepare('insert into chat_handle_join (chat_id, handle_id) values (?, ?)');
  for (const [c, h] of [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 1],
    [4, 4],
    [5, 1],
    [6, 5],
  ])
    member.run(c, h);

  ids.visible = add(db, 1, 1, 0, 'dinner at 7?');
  add(db, 1, 0, 1, 'sure, see you there');
  add(db, 6, 5, 2, 'Are you interested in selling your home?');
  ids.linda = add(db, 2, 2, 10, 'secret word quartzlinda');
  add(db, 2, 0, 11, 'ok Mom');
  ids.riley = add(db, 3, 3, 20, 'secret word quartzriley', { att: true });
  db.prepare(
    "insert into attachment (ROWID, guid, original_guid, filename, mime_type, uti, transfer_name, total_bytes) values (1, 'A-1', 'A-1', ?, 'image/jpeg', 'public.jpeg', 'IMG_SECRET.JPG', 100)",
  ).run(join(dir, 'IMG_SECRET.JPG'));
  db.prepare('insert into message_attachment_join (message_id, attachment_id) values (?, 1)').run(rowid);
  ids.rileyLink = add(db, 3, 3, 21, 'https://secret.example/plan', {
    balloon: 'com.apple.messages.URLBalloonProvider',
    payload: PLIST.linkCabin,
  });
  ids.book = add(db, 4, 1, 30, 'secret word quartzbook');
  ids.bookReply = add(db, 4, 4, 31, 'replying in the thread', { thread: `G-${rowid}` });
  ids.plans = add(db, 5, 1, 40, 'secret word quartzplans');
  db.close();

  const cfg = fixtureBridgeConfig(dir, { HIDE: HIDE.join(',') });
  store = new LiveStore(cfg);
  store.start();
  await waitFor(() => store.indexStatus().ready, 'the search index to build');
  client = await connect(
    buildServer({
      store,
      cfg: cfg.tools,
      baseUrl: 'https://imessage.example',
      sendLog: [],
      scopes: new Set(ALL_SCOPES),
      resourceMetadataUrl: '',
    }),
  );
});
after(() => {
  store?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const called = new Set<string>();
/** Calls a tool and fails on any forbidden string that the arguments didn't already contain. */
async function probe(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  called.add(name);
  const r = (await client.callTool({ name, arguments: { intent: 'HIDE regression test', ...args } })) as Result;
  const out = `${text(r)}\n${JSON.stringify(r.structuredContent ?? {})}`;
  // An error may echo what was asked, maybe reformatted ("+15555550111" as "(555) 555-0111"); that is not a leak.
  const asked = JSON.stringify(args);
  const echoed = (f: string) =>
    asked.includes(f) ||
    (/\d{7}/.test(f.replace(/\D/g, '')) && asked.replace(/\D/g, '').includes(f.replace(/\D/g, '')));
  const leaks = FORBIDDEN.filter((f) => out.includes(f) && !echoed(f));
  assert.deepEqual(leaks, [], `${name} ${asked} leaked:\n${out}`);
  return r;
}

describe('HIDE on a fixture chat.db', () => {
  it('a store with nothing hidden would show all of it (the fixture is not vacuous)', async () => {
    const open = new LiveStore(fixtureBridgeConfig(dir, { DATA_DIR: join(dir, 'data-open') }));
    open.start();
    try {
      assert.equal(open.chats().length, 6);
      assert.ok(open.message(ids.linda));
      assert.ok(open.people().some((p) => p.name === 'Riley Park'));
    } finally {
      open.stop();
    }
  });

  it('hides people by name, email and differently formatted phone, and chats by chat_id or member', () => {
    assert.deepEqual(
      store
        .people()
        .map((p) => p.name ?? p.handles[0].address)
        .sort(),
      ['+15555550199', 'Sam Ortiz'],
    );
    assert.deepEqual(
      store
        .chats()
        .map((c) => c.chatId)
        .sort(),
      ['any;-;+15555550142', 'any;-;+15555550199'],
    );
    for (const id of [ids.linda, ids.riley, ids.rileyLink, ids.book, ids.bookReply, ids.plans])
      assert.equal(store.message(id), undefined, id);
    assert.equal(store.attachment('a1'), undefined);
    const sam = store.people().find((p) => p.name === 'Sam Ortiz')!;
    assert.deepEqual(store.personActivity(sam.personId).groupChatIds, []);
  });

  it('finding and searching never surface a hidden word, name or number', async () => {
    for (const query of ['Lin', 'Mo', 'quartz', '0111', '0122', 'Park', 'Book', 'secret word'])
      await probe('find', { query });
    for (const query of ['Lin', '0122', 'riley']) await probe('search_people', { query, include_unknown: true });
    for (const args of [
      { query: 'quartz' },
      { query: 'secret word', match: 'any' },
      {},
      { with: 'Sam Ortiz' },
      { chat_type: 'group' },
      { has_attachment: true },
      { has_link: true },
    ])
      await probe('search_messages', args);
    await probe('search', { query: 'quartz' });
    await probe('search', { query: 'secret word' });
  });

  it('listing, reading and catching up show only the visible chats', async () => {
    for (const args of [{ senders: 'all' }, { query: 'Book' }, { type: 'group' }, { person: 'Sam Ortiz' }])
      await probe('list_conversations', args);
    for (const chat of ['Mom', 'any;-;+15555550111', 'iMessage;+;chat777', 'iMessage;+;chat500', '+15555550122'])
      assert.equal((await probe('read_conversation', { chat })).isError, true, chat);
    await probe('read_conversation', { chat: 'Sam Ortiz' });
    await probe('get_conversation', { chat: 'Sam Ortiz', include_stats: true, include_history: true });
    assert.equal((await probe('get_conversation', { chat: 'riley@example.com' })).isError, true);
    await probe('catch_up', { senders: 'all' });
    await probe('catch_up', { since: '30d', senders: 'all' });
  });

  it('hidden ids answer like ids that do not exist', async () => {
    for (const message_id of [ids.linda, ids.riley, ids.book, ids.plans])
      assert.equal((await probe('get_message', { message_id })).isError, true, message_id);
    await probe('get_message', { message_id: ids.visible, context_before: 20, context_after: 20 });
    assert.equal((await probe('get_reply_thread', { message_id: ids.book })).isError, true);
    for (const mode of ['metadata', 'text', 'link'])
      assert.equal((await probe('get_attachment', { attachment_id: 'a1', mode })).isError, true, mode);
    for (const id of [`msg:${ids.linda}`, 'chat:any;-;+15555550111', 'att:a1'])
      assert.equal((await probe('fetch', { id })).isError, true, id);
  });

  it('people, stats, attachments, links and status count only what is visible', async () => {
    await probe('get_person', { person: 'Sam Ortiz', include_groups: true, include_stats: true });
    for (const person of ['Linda Carter', 'riley@example.com', '+15555550122', 'Mom'])
      assert.equal((await probe('get_person', { person })).isError, true, person);
    for (const group_by of ['person', 'chat', 'month']) {
      const r = await probe('get_stats', { group_by, senders: 'all' });
      assert.equal(r.structuredContent.total, 3, `${group_by}: the three visible messages`);
    }
    await probe('list_attachments', {});
    await probe('list_attachments', { name_query: 'IMG' });
    await probe('list_links', {});
    await probe('list_links', { domain: 'example.com' });
    await probe('get_status', {});
  });

  it('a forged cursor cannot read around HIDE', async () => {
    const o = '(select group_concat(text) from message)';
    const r = await probe('search_messages', { query: 'dinner', cursor: encodeCursor({ k: 'sm', o }) });
    assert.match(text(r), /^Error invalid_cursor/);
  });

  it('new messages in hidden chats never reach poll() or get_updates', async () => {
    const start = (await probe('get_updates', { cursor: 'now' })).structuredContent.next_cursor;
    const seq = store.latestSeq();
    const db = new DatabaseSync(chatDb);
    try {
      add(db, 2, 2, 100, 'new quartzlinda');
      add(db, 4, 4, 101, 'new quartzbook');
      add(db, 5, 1, 102, 'new quartzplans');
    } finally {
      db.close();
    }
    store.poll();
    assert.deepEqual(store.updatesSince(seq), []);
    const db2 = new DatabaseSync(chatDb);
    try {
      add(db2, 1, 1, 103, 'still on for dinner?');
    } finally {
      db2.close();
    }
    store.poll();
    assert.deepEqual(
      store.updatesSince(seq).map((e) => e.chatId),
      ['any;-;+15555550142'],
    );
    const upd = await probe('get_updates', { cursor: start });
    assert.match(text(upd), /still on for dinner\?/);
  });

  it('the sweep reached every read-only tool', async () => {
    const readOnly = (await client.listTools()).tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    assert.deepEqual(
      readOnly.filter((n) => !called.has(n)),
      [],
      'add a probe for each new read-only tool',
    );
  });
});
