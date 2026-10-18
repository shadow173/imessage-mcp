import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_SCOPES } from '../src/auth/scopes.js';
import { effectAppleId } from '../src/domain/effects.js';
import { ImsgError, type ImsgStatus, type PrivateApi } from '../src/live/imsgRpc.js';
import { LiveStore } from '../src/live/liveStore.js';
import { createSender, SEND_TO_CHAT, SEND_TO_PARTICIPANT } from '../src/live/sender.js';
import { buildServer } from '../src/server.js';
import { ME } from '../src/store/types.js';
import { PLIST } from './fixtures/blobs.js';
import { appleNs, createAddressBook, createChatDb, fixtureBridgeConfig } from './helpers/chatdb.js';
import { makeCtx } from './helpers/ctx.js';
import { connectTools, errCode } from './helpers/mcp.js';
import { encodeAttributedBody as body } from './helpers/typedstream.js';
import { waitFor } from './helpers/wait.js';

const T0 = Date.UTC(2026, 9, 1, 16, 0); // Oct 1 2026, noon EDT
let dir: string;
let store: LiveStore;
let client: Client;
const ids: Record<string, string> = {};
let chatDbPath: string;
let cfgRef: ReturnType<typeof fixtureBridgeConfig>;
/** The store's Private API forwards to this, so the private API tests can install their fake helper. */
let helper: PrivateApi | undefined;
const viaHelper: PrivateApi = {
  status: () => helper!.status(),
  call: (method, params) => helper!.call(method, params),
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'imsg-live-'));
  chatDbPath = join(dir, 'chat.db');
  const db = createChatDb(chatDbPath);
  createAddressBook(dir, [
    { first: 'Sam', last: 'Ortiz', phones: ['(555) 555-0142'], emails: ['Sam.Ortiz@Example.com'] },
    { first: 'Sam', last: 'Lee', phones: ['+1 555-555-0177'] },
    { first: 'Linda', last: 'Carter', nickname: 'Mom', phones: ['555-555-0111'] },
  ]);

  const h = db.prepare('insert into handle (ROWID, id, service) values (?, ?, ?)');
  h.run(1, '+15555550142', 'iMessage');
  h.run(2, '+15555550142', 'SMS');
  h.run(3, 'sam.ortiz@example.com', 'iMessage');
  h.run(4, '+15555550177', 'iMessage');
  h.run(5, '+15555550199', 'SMS');
  h.run(6, '+15555550111', 'iMessage');
  const c = db.prepare(
    'insert into chat (ROWID, guid, style, chat_identifier, service_name, display_name) values (?, ?, ?, ?, ?, ?)',
  );
  c.run(1, 'any;-;+15555550142', 45, '+15555550142', 'iMessage', null);
  c.run(2, 'any;-;sam.ortiz@example.com', 45, 'sam.ortiz@example.com', 'iMessage', null);
  c.run(3, 'any;+;chat123', 43, 'chat123', 'iMessage', 'Cabin');
  c.run(4, 'any;-;+15555550199', 45, '+15555550199', 'SMS', null);
  c.run(5, 'any;-;+15555550111', 45, '+15555550111', 'iMessage', null);
  const chj = db.prepare('insert into chat_handle_join (chat_id, handle_id) values (?, ?)');
  chj.run(1, 1);
  chj.run(2, 3);
  chj.run(3, 1);
  chj.run(3, 4);
  chj.run(4, 5);
  chj.run(5, 6);

  let rowid = 0;
  const msg =
    db.prepare(`insert into message (ROWID, guid, text, attributedBody, handle_id, is_from_me, service, date, date_edited, is_read, item_type, group_title,
    associated_message_guid, associated_message_type, thread_originator_guid, cache_has_attachments, balloon_bundle_id, message_summary_info, payload_data)
    values (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const cmj = db.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (?, ?, ?)');
  const add = (
    chat: number,
    handle: number,
    mine: boolean,
    minute: number,
    text: string | null,
    o: Record<string, any> = {},
  ) => {
    rowid++;
    const guid = `G-${rowid}`;
    const d = appleNs(T0 + minute * 60_000);
    msg.run(
      rowid,
      guid,
      text === null ? null : body(text),
      handle,
      mine ? 1 : 0,
      o.service ?? 'iMessage',
      d,
      o.edited ? appleNs(T0 + (minute + 1) * 60_000) : 0,
      o.read ?? 1,
      o.itemType ?? 0,
      o.groupTitle ?? null,
      o.assocGuid ?? null,
      o.assocType ?? 0,
      o.thread ?? null,
      o.att ? 1 : 0,
      o.balloon ?? null,
      o.summary ?? null,
      o.payload ?? null,
    );
    cmj.run(chat, rowid, d);
    return { rowid, guid, id: `m${rowid}` };
  };
  // Chat 1: 250 filler messages for paging, then the interesting ones.
  for (let i = 0; i < 250; i++) add(1, 1, i % 2 === 0, i, `filler ${i}`);
  const sat = add(1, 1, false, 300, 'are we still on for saturday?');
  ids.sat = sat.id;
  add(1, 0, true, 301, null, { assocGuid: `p:0/${sat.guid}`, assocType: 2000 });
  add(1, 1, false, 302, null, { assocGuid: `p:0/${sat.guid}`, assocType: 2001 });
  add(1, 1, false, 303, null, { assocGuid: `p:0/${sat.guid}`, assocType: 3001 });
  ids.edited = add(1, 1, false, 304, "perfect, I'll bring the grill", { edited: true, summary: PLIST.editGrill }).id;
  ids.unsent = add(1, 0, true, 305, null, {
    edited: true,
    summary: PLIST.unsent,
  }).id;
  const photo = add(1, 0, true, 306, '\uFFFC', { att: true }); // where Messages puts the attachment in the text
  ids.photo = photo.id;
  db.prepare(
    "insert into attachment (ROWID, guid, original_guid, filename, mime_type, uti, transfer_name, total_bytes) values (1, 'A-1', 'A-1', '~/Library/Messages/Attachments/aa/IMG_1.HEIC', 'image/heic', 'public.heic', 'IMG_1.HEIC', 2048)",
  ).run();
  db.prepare('insert into message_attachment_join (message_id, attachment_id) values (?, 1)').run(photo.rowid);
  ids.link = add(1, 1, false, 307, 'https://example.com/cabin', {
    balloon: 'com.apple.messages.URLBalloonProvider',
    payload: PLIST.linkCabin,
  }).id;
  add(2, 3, false, 310, 'testing the email address');
  // Group chat with an inline reply thread and a rename.
  add(3, 1, false, 320, null, { itemType: 2, groupTitle: 'Cabin' });
  const driving = add(3, 4, false, 321, "who's driving?");
  ids.driving = driving.id;
  ids.reply = add(3, 1, false, 322, 'I can take a second car', { thread: driving.guid }).id;
  // Unknown sender, unread. Hidden chat with Mom.
  add(4, 5, false, 330, 'Are you interested in selling your home?', { service: 'SMS', read: 0 });
  add(5, 6, false, 340, 'secret family stuff about saturday');
  db.close();

  const cfg = fixtureBridgeConfig(dir, { HIDE: '+15555550111' });
  cfgRef = cfg;
  store = new LiveStore(cfg, { privateApi: viaHelper });
  store.start();
  await waitFor(() => store.indexStatus().ready, 'the search index to build');
  const server = buildServer({
    store,
    cfg: cfg.tools,
    baseUrl: 'https://example.invalid',
    sendLog: [],
    scopes: new Set(ALL_SCOPES),
    resourceMetadataUrl: 'https://example.invalid/x',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 't', version: '1' });
  await client.connect(b);
});
after(() => {
  store?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const text = async (name: string, args: Record<string, unknown>) =>
  (
    (await client.callTool({ name, arguments: { intent: 'live store test on a fixture chat.db', ...args } })) as any
  ).content
    .map((c: any) => c.text)
    .join('\n');

describe('LiveStore on a fixture chat.db', () => {
  it('merges one person across phone, SMS and email handles, and hides configured people', () => {
    const sam = store.people().find((p) => p.name === 'Sam Ortiz')!;
    assert.deepEqual(sam.handles.map((h) => h.address).sort(), ['+15555550142', 'sam.ortiz@example.com']);
    assert.deepEqual(sam.handles.find((h) => h.address === '+15555550142')!.services.sort(), ['SMS', 'iMessage']);
    assert.equal(
      store.people().some((p) => p.name === 'Linda Carter'),
      false,
    );
    assert.equal(store.chats().length, 4);
    const act = store.personActivity(sam.personId);
    assert.equal(act.dmChatIds.length, 2);
    assert.equal(act.groupChatIds.length, 1);
  });

  it('pages a chat back to the first message with no gaps or repeats', () => {
    const seen = new Set<string>();
    let page = store.pageChat('any;-;+15555550142', {}, { limit: 100, anchor: 'end' });
    const total = page.total;
    while (true) {
      for (const m of page.items) {
        assert.ok(!seen.has(m.messageId));
        seen.add(m.messageId);
      }
      if (!page.hasOlder) break;
      page = store.pageChat(
        'any;-;+15555550142',
        {},
        { limit: 100, before: { t: page.items[0].sentAt, id: page.items[0].messageId }, anchor: 'end' },
      );
    }
    assert.equal(seen.size, total);
    assert.equal(total, 250 + 5); // filler + sat + edited + unsent + photo + link (tapbacks are folded, not rows)
  });

  it('folds tapbacks, honoring removals', () => {
    const m = store.message(ids.sat)!;
    assert.deepEqual(
      m.reactions.map((r) => [r.kind, r.by]),
      [['love', ME]],
    );
  });

  it('decodes edits, unsends, attachments and link previews', () => {
    const e = store.message(ids.edited)!;
    assert.ok(e.editedAt);
    assert.equal(e.editHistory?.[0]?.text, "perfect, I'll bring the girl");
    assert.equal(store.message(ids.unsent)!.unsent, true);
    const p = store.message(ids.photo)!;
    assert.equal(p.text, '');
    assert.equal(store.attachment(p.attachmentIds[0])!.kind, 'image');
    const l = store.message(ids.link)!;
    assert.deepEqual(l.link, { url: 'https://example.com/cabin', title: 'Lakeside cabin', site: 'example.com' });
  });

  it('resolves inline replies and group events', () => {
    assert.equal(store.message(ids.reply)!.replyToId, ids.driving);
    assert.deepEqual(
      store.threadReplies(ids.driving).map((m) => m.messageId),
      [ids.reply],
    );
    const ev = store.chatActivity('any;+;chat123').groupEvents;
    assert.equal(ev[0].system?.detail, 'named the conversation "Cabin"');
  });

  it('summarizes chats with unread and unknown-sender flags', () => {
    const s = store.summarizeChat('any;-;+15555550199');
    assert.equal(s.unreadCount, 1);
    assert.equal(s.unknownSender, true);
    assert.equal(store.summarizeChat('any;+;chat123').title, 'Cabin');
  });

  it('searches the index, and never returns hidden chats', () => {
    const r = store.search({ text: 'saturday' }, { sort: 'relevance', limit: 10, offset: 0 });
    assert.deepEqual(
      r.items.map((m) => m.messageId),
      [ids.sat],
    );
    assert.equal(
      store.search({ text: 'cabin' }, { sort: 'newest', limit: 10, offset: 0 }).items[0].messageId,
      ids.link,
    );
    assert.equal(
      store.search({ text: 'IMG_1' }, { sort: 'newest', limit: 10, offset: 0 }).items[0].messageId,
      ids.photo,
    );
    assert.equal(store.search({ text: 'secret' }, { sort: 'newest', limit: 10, offset: 0 }).total, 0);
  });

  it('serves the same tools as the mock', async () => {
    const t = await text('read_conversation', { chat: 'any;-;+15555550142', limit: 8 });
    assert.match(t, /❤️ You/);
    assert.match(t, /\(edited\)/);
    assert.match(t, /\[unsent\]/);
    assert.match(t, /\[photo IMG_1\.HEIC/);
    assert.match(t, /\[link "Lakeside cabin"\]/);
    const g = await text('read_conversation', { chat: 'Cabin' });
    assert.match(g, /↳ reply to "who's driving\?"/);
    assert.match(await text('read_conversation', { chat: 'Sam' }), /ambiguous/);
    assert.match(await text('search_messages', { query: 'saturday' }), /are we still on for saturday/);
    assert.match(await text('get_person', { person: 'sam.ortiz@example.com' }), /"dm_chats"/);
  });

  it('list_links matches the preview title, not only the URL, and filters by domain', async () => {
    assert.match(await text('list_links', { query: 'lakeside' }), /Lakeside cabin/);
    assert.match(await text('list_links', { query: 'lakeside', domain: 'www.example.com' }), /Lakeside cabin/);
    assert.match(await text('list_links', { query: 'lakeside', domain: 'other.example' }), /No links/);
  });

  describe('sending (fake Messages)', () => {
    const calls: { script: string; args: string[] }[] = [];
    /** Plays Messages: appends the sent row to chat.db like Messages would. */
    const fakeMessages =
      (opts: { fail?: string; error?: number; writeRow?: boolean } = {}) =>
      async (script: string, args: string[]) => {
        calls.push({ script, args });
        if (opts.fail) throw new Error(opts.fail);
        if (opts.writeRow === false || !args[0]) return;
        const w = new DatabaseSync(chatDbPath);
        const max = Number((w.prepare('select max(ROWID) r from message').get() as any).r) + 1;
        const chatRow = script === SEND_TO_CHAT ? 3 : args[1] === '+15555550199' ? 4 : 1;
        const handle = chatRow === 3 ? 0 : chatRow === 4 ? 5 : 1;
        w.prepare(
          'insert into message (ROWID, guid, attributedBody, handle_id, is_from_me, service, date, is_sent, is_delivered, error) values (?, ?, ?, ?, 1, ?, ?, 1, 1, ?)',
        ).run(max, `S-${max}`, body(args[0]), handle, args[2], appleNs(Date.now()), opts.error ?? 0);
        w.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (?, ?, ?)').run(
          chatRow,
          max,
          appleNs(Date.now()),
        );
        w.close();
      };

    it('sends 1:1 by participant, verifies the row, and replays by idempotency key', async () => {
      const send = createSender(store, cfgRef, fakeMessages(), 2000);
      const r = await send({ chatId: 'any;-;+15555550142' }, 'found your charger!', [], 'auto', 'k-1');
      assert.equal(r.disposition, 'delivered');
      assert.equal(calls.at(-1)!.script, SEND_TO_PARTICIPANT);
      assert.deepEqual(calls.at(-1)!.args, ['found your charger!', '+15555550142', 'iMessage', '']);
      assert.equal(r.message?.text, 'found your charger!');
      const n = calls.length;
      const again = await send({ chatId: 'any;-;+15555550142' }, 'found your charger!', [], 'auto', 'k-1');
      assert.equal(again.message?.messageId, r.message?.messageId);
      assert.equal(calls.length, n);
    });

    it('sends to groups by chat id and picks SMS for SMS chats', async () => {
      const send = createSender(store, cfgRef, fakeMessages(), 2000);
      assert.equal(
        (await send({ chatId: 'any;+;chat123' }, 'grocery run at 7', [], 'auto', 'k-2')).disposition,
        'delivered',
      );
      assert.equal(calls.at(-1)!.script, SEND_TO_CHAT);
      assert.equal(calls.at(-1)!.args[1], 'any;+;chat123');
      await send({ chatId: 'any;-;+15555550199' }, 'STOP', [], 'auto', 'k-3');
      assert.equal(calls.at(-1)!.args[2], 'SMS');
    });

    it('reports permission errors, delivery errors and unconfirmed sends with the right retry advice', async () => {
      const denied = await createSender(
        store,
        cfgRef,
        fakeMessages({ fail: 'execution error: Not authorized to send Apple events to Messages. (-1743)' }),
        500,
      )({ chatId: 'any;-;+15555550142' }, 'x', [], 'auto', 'k-4');
      assert.equal(denied.disposition, 'failed');
      assert.equal(denied.error?.code, 'automation_denied');
      assert.equal(denied.retrySafe, true);
      const bounced = await createSender(store, cfgRef, fakeMessages({ error: 22 }), 2000)(
        { chatId: 'any;-;+15555550142' },
        'bounce me',
        [],
        'auto',
        'k-5',
      );
      assert.equal(bounced.disposition, 'failed');
      assert.equal(bounced.error?.code, 'not_delivered');
      const ghost = await createSender(store, cfgRef, fakeMessages({ writeRow: false }), 600)(
        { chatId: 'any;-;+15555550142' },
        'vanishes',
        [],
        'auto',
        'k-6',
      );
      assert.equal(ghost.disposition, 'may_have_completed');
      assert.equal(ghost.retrySafe, false);
    });

    it('stages attachments inside the Messages attachments folder', async () => {
      const send = createSender(store, cfgRef, fakeMessages(), 600);
      await send(
        { chatId: 'any;-;+15555550142' },
        '',
        [{ filename: '../../evil name.png', mime: 'image/png', base64: Buffer.from('png').toString('base64') }],
        'auto',
        'k-7',
      );
      const file = calls.at(-1)!.args[3];
      assert.ok(file.startsWith(cfgRef.attachmentsStageDir));
      assert.ok(file.endsWith('evil name.png'));
      assert.ok(!file.includes('..'));
    });
  });

  it('turns new rows, edits and receipts into update events', async () => {
    const start = store.latestSeq();
    const w = new DatabaseSync(chatDbPath);
    const max = Number((w.prepare('select max(ROWID) r from message').get() as any).r) + 1;
    w.prepare(
      'insert into message (ROWID, guid, attributedBody, handle_id, is_from_me, service, date, is_read) values (?, ?, ?, 1, 0, ?, ?, 0)',
    ).run(max, `U-${max}`, body('new one just now'), 'iMessage', appleNs(Date.now()));
    w.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (1, ?, ?)').run(
      max,
      appleNs(Date.now()),
    );
    w.prepare(
      'insert into message (ROWID, guid, handle_id, is_from_me, service, date, associated_message_guid, associated_message_type) values (?, ?, 1, 0, ?, ?, ?, 2003)',
    ).run(max + 1, `U-${max + 1}`, 'iMessage', appleNs(Date.now()), `p:0/U-${max}`);
    w.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (1, ?, ?)').run(
      max + 1,
      appleNs(Date.now()),
    );
    w.close();
    store.poll();
    const ev = store.updatesSince(start);
    assert.deepEqual(
      ev.map((e) => [e.type, e.messageId]),
      [
        ['new', `m${max}`],
        ['reaction', `m${max}`],
      ],
    );
    assert.equal(store.summarizeChat('any;-;+15555550142').lastMessage?.text, 'new one just now');
    assert.equal(
      store.search({ text: 'just now' }, { sort: 'newest', limit: 5, offset: 0 }).items[0]?.messageId,
      `m${max}`,
    );
  });

  describe('private API (fake imsg helper)', () => {
    const calls: { method: string; params: Record<string, any> }[] = [];
    const status: ImsgStatus = {
      bridgeReady: true,
      methods: [
        'tapback',
        'message.edit',
        'message.unsend',
        'read',
        'chats.markUnread',
        'typing',
        'send.rich',
        'group.rename',
      ],
    };
    /** The fields the fake reads from a Private API call's params. */
    type FakeCallParams = {
      remove?: boolean;
      reaction: string;
      message_guid: string;
      text: string;
      reply_to?: string;
      effect_id?: string;
    };
    let failNext: ImsgError | null = null;
    const db = () => new DatabaseSync(chatDbPath);
    /** Plays Messages: applies each bridge action to chat.db the way Messages would. */
    const fake: PrivateApi = {
      status: async () => status,
      call: async <T>(method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        const a = params as FakeCallParams;
        if (failNext) {
          const e = failNext;
          failNext = null;
          throw e;
        }
        const w = db();
        const max = Number((w.prepare('select max(ROWID) r from message').get() as any).r) + 1;
        if (method === 'tapback') {
          const type =
            (a.remove ? 3000 : 2000) +
            ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'].indexOf(a.reaction);
          w.prepare(
            'insert into message (ROWID, guid, handle_id, is_from_me, service, date, associated_message_guid, associated_message_type) values (?, ?, 0, 1, ?, ?, ?, ?)',
          ).run(max, `T-${max}`, 'iMessage', appleNs(Date.now()), `p:0/${a.message_guid}`, type);
          w.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (1, ?, ?)').run(
            max,
            appleNs(Date.now()),
          );
        } else if (method === 'message.edit') {
          w.prepare('update message set attributedBody = ?, date_edited = ? where guid = ?').run(
            body(a.text),
            appleNs(Date.now()),
            a.message_guid,
          );
        } else if (method === 'message.unsend') {
          w.prepare(
            'update message set attributedBody = NULL, text = NULL, date_edited = ?, message_summary_info = ? where guid = ?',
          ).run(appleNs(Date.now()), PLIST.unsent, a.message_guid);
        } else if (method === 'read') {
          w.prepare(
            'update message set is_read = 1 where ROWID in (select message_id from chat_message_join where chat_id = 4)',
          ).run();
        } else if (method === 'send.rich') {
          w.prepare(
            'insert into message (ROWID, guid, attributedBody, handle_id, is_from_me, service, date, is_sent, is_delivered, thread_originator_guid, expressive_send_style_id) values (?, ?, ?, 1, 1, ?, ?, 1, 1, ?, ?)',
          ).run(
            max,
            `R-${max}`,
            body(a.text),
            'iMessage',
            appleNs(Date.now()),
            a.reply_to ?? null,
            a.effect_id ?? null,
          );
          w.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (1, ?, ?)').run(
            max,
            appleNs(Date.now()),
          );
        }
        w.close();
        return { ok: true } as T;
      },
    };
    const mineNow = (text: string) => {
      const w = db();
      const max = Number((w.prepare('select max(ROWID) r from message').get() as any).r) + 1;
      w.prepare(
        'insert into message (ROWID, guid, attributedBody, handle_id, is_from_me, service, date, is_sent, is_delivered) values (?, ?, ?, 1, 1, ?, ?, 1, 1)',
      ).run(max, `M-${max}`, body(text), 'iMessage', appleNs(Date.now()));
      w.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (1, ?, ?)').run(
        max,
        appleNs(Date.now()),
      );
      w.close();
      store.poll();
      return `m${max}`;
    };

    before(() => {
      helper = fake;
    });

    it('reports a clear error when the helper is not set up or not running', async () => {
      await assert.rejects(new LiveStore(cfgRef).react(ids.sat, 'like', undefined, false), /Private API tier/);
      const notRunning = new LiveStore(cfgRef, {
        privateApi: { ...fake, status: async () => ({ bridgeReady: false, methods: [], reason: 'not injected' }) },
      });
      await assert.rejects(
        notRunning.react(ids.sat, 'like', undefined, false),
        (e: any) => e.code === 'private_api_unavailable',
      );
    });

    it('reacts by message guid and returns the message with the tapback folded in', async () => {
      const m = await store.react(ids.edited, 'laugh', undefined, false);
      assert.deepEqual(calls.at(-1), {
        method: 'tapback',
        params: {
          chat_guid: 'any;-;+15555550142',
          message_guid: `G-${ids.edited.slice(1)}`,
          reaction: 'laugh',
          remove: false,
          part_index: 0,
        },
      });
      assert.ok(m.reactions.some((r) => r.by === ME && r.kind === 'laugh'));
      await assert.rejects(
        store.react(ids.edited, 'emoji', '🔥', false),
        (e: any) => e.code === 'unsupported_reaction',
      );
    });

    it('edits and unsends only your own recent iMessages', async () => {
      const id = mineNow('see you at 7');
      const e = await store.edit(id, 'see you at 8');
      assert.equal(e.text, 'see you at 8');
      assert.ok(e.editedAt);
      const { call } = await connectTools(makeCtx({}, { store }));
      assert.equal(errCode(await call('edit_message', { message_id: ids.sat, text: 'nope' })), 'not_yours');
      assert.equal(
        errCode(await call('edit_message', { message_id: ids.photo, text: 'too late' })),
        'edit_window_passed',
      );
      const id2 = mineNow('oops wrong chat');
      assert.equal((await store.unsend(id2)).unsent, true);
    });

    it('marks a chat read and maps an uncertain outcome to "do not retry blindly"', async () => {
      assert.equal(store.summarizeChat('any;-;+15555550199').unreadCount, 1);
      await store.markRead('any;-;+15555550199', false);
      store.poll();
      assert.equal(store.summarizeChat('any;-;+15555550199').unreadCount, 0);
      failNext = new ImsgError(-32001, 'timed out', 'may_have_completed', false);
      await assert.rejects(store.setTyping('any;-;+15555550142', true), (e: any) => e.code === 'outcome_unknown');
    });

    it('sends inline replies with effects through send.rich and verifies the row', async () => {
      const send = createSender(
        store,
        cfgRef,
        async () => {
          throw new Error('AppleScript must not be used for rich sends');
        },
        2000,
      );
      const r = await send({ chatId: 'any;-;+15555550142' }, 'on my way', [], 'auto', 'rich-1', {
        replyTo: ids.sat,
        effect: 'confetti',
      });
      assert.equal(r.disposition, 'delivered');
      assert.deepEqual(calls.at(-1)?.params, {
        chat_guid: 'any;-;+15555550142',
        text: 'on my way',
        reply_to: `G-${ids.sat.slice(1)}`,
        effect_id: effectAppleId('confetti'),
      });
      assert.equal(r.message?.replyToId, ids.sat);
      assert.equal(r.message?.effect, 'confetti');
      await assert.rejects(
        send({ address: '+15550001111' }, 'hi', [], 'auto', 'rich-2', { replyTo: ids.sat }),
        (e: any) => e.code === 'needs_existing_chat',
      );
    });
  });
});
