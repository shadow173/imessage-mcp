import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ALL_SCOPES } from '../src/auth/scopes.js';
import { loadToolConfig } from '../src/config.js';
import { encodeCursor } from '../src/lib/cursor.js';
import { MAX_UPDATE_HOLD_S } from '../src/lib/limits.js';
import { fmtIso, fmtRange, resolveRange } from '../src/lib/time.js';
import type { MockStore } from '../src/mock/mockStore.js';
import { CODE_MARKER } from '../src/policy/redact.js';
import type { Message } from '../src/store/types.js';
import type { Ctx } from '../src/tools/context.js';
import { READ_TOOLS } from '../src/tools/read/index.js';
import { registerTools } from '../src/tools/registry.js';
import { type Result, text } from './helpers/mcp.js';
import { newMockStore } from './helpers/mock.js';

const TZ = 'America/New_York';
const INTENT = 'unit test of the read tools';
const MOM = 'iMessage;-;+15555550111';
const SAM_LEE = 'iMessage;-;+15555550177';
const SAM_O = 'iMessage;-;+15555550142';
const SAM_O_EMAIL = 'iMessage;-;sam.ortiz@example.com';
const PRIYA = 'iMessage;-;+15555550155';
const CABIN = 'iMessage;+;chat58213';
const JO = 'iMessage;-;+15555550133';

async function setup() {
  const store = newMockStore();
  const ctx: Ctx = {
    store,
    cfg: loadToolConfig({} as NodeJS.ProcessEnv, {
      timeZone: TZ,
      linkSecret: 'read-test-link-secret-0123456789',
      tiers: 'read,send,org,pa,gpt',
    }),
    baseUrl: 'https://imessage.example',
    sendLog: [],
    scopes: new Set(ALL_SCOPES),
    resourceMetadataUrl: 'https://imessage.example/.well-known/oauth-protected-resource/mcp',
  };
  const server = new McpServer({ name: 'read-test', version: '1' });
  registerTools(server, READ_TOOLS, ctx.cfg, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'read-test', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { intent: INTENT, ...args } })) as Result;
  return { store, client, call };
}
const cursorOf = (c: string) => JSON.parse(Buffer.from(c.slice(2), 'base64url').toString('utf8'));
const allIn = (store: MockStore, chatId: string) => store.pageChat(chatId, {}, { limit: 5000, anchor: 'end' }).items;
const firstIn = (store: MockStore, chatId: string) =>
  store.pageChat(chatId, {}, { limit: 1, anchor: 'start' }).items[0];

describe('catch_up', () => {
  it('keeps totals before cutting, so overflow unread chats never slide into waiting', async () => {
    const { call } = await setup();
    const t = text(await call('catch_up', { max_chats: 2, messages_per_chat: 1 }));
    assert.match(t, /Unread \(2 of 4\)/);
    assert.match(t, /\+2 more not shown · max_chats=50 to see more/);
    const waiting = t.slice(t.indexOf('Waiting on your reply'));
    assert.doesNotMatch(waiting, /Priya Nair|Cabin Weekend/);
    const j = (await call('catch_up', { max_chats: 1, format: 'json' })).structuredContent;
    assert.equal(j.unread.length, 1);
    assert.equal(j.unread_total, 4);
    assert.ok(j.needs_reply_total >= j.needs_reply.length);
    assert.ok(j.needs_reply.every((c: any) => c.unread_count === 0));
  });

  it('JSON carries as_of, mode, since, totals and the hidden unknown count; text shows As of', async () => {
    const { store, call } = await setup();
    const r = await call('catch_up', { format: 'json' });
    const j = r.structuredContent;
    assert.equal(Object.keys(j)[0], 'notice');
    assert.equal(j.mode, 'unread');
    assert.equal(j.since, null);
    assert.match(j.as_of, /^2026-10-17T16:47:\d\d-04:00$/);
    const unknownUnread = store.chatSummaries().filter((s) => s.unknownSender && s.unreadCount > 0).length;
    assert.equal(j.hidden_unknown_unread, unknownUnread);
    assert.deepEqual(j.upcoming_reminders, []);
    const t = text(await call('catch_up', {}));
    assert.match(t, /^⚠ .*\nAs of Sat Oct 17 16:47 EDT\n/);
    assert.match(t, new RegExp(`${unknownUnread} unread chats from unknown senders hidden · senders=all to include`));
  });

  it('since: new activity, an older-waiting section, and a footer for older unread chats', async () => {
    const { call } = await setup();
    const t = text(await call('catch_up', { since: '1h', include_needs_reply: false }));
    assert.match(t, /\nNew since Sat Oct 17 15:47 EDT \(0\)\n/);
    assert.match(t, /4 unread chats with messages before .* not shown · omit since to include/);
    assert.match(t, /1 active chat from unknown senders hidden/);
    const w = text(await call('catch_up', { since: '1h' }));
    assert.match(w, /Older, still waiting on your reply \(\d+\)/);
    const j = (await call('catch_up', { since: '1h', include_needs_reply: false, format: 'json' })).structuredContent;
    assert.equal(j.mode, 'since');
    assert.match(j.since, /^\d{4}-/);
    assert.equal(j.older_unread_not_shown, 4);
  });

  it('waiting on your reply ranks known 1:1s, then groups, then broadcasts, with labels', async () => {
    const { call } = await setup();
    const t = text(await call('catch_up', { messages_per_chat: 1 }));
    const w = t.slice(t.indexOf('Waiting on your reply'), t.indexOf('Reminders due'));
    const at = (s: string) => {
      const i = w.indexOf(s);
      assert.ok(i >= 0, `${s} missing`);
      return i;
    };
    assert.ok(at('■ Linda Carter') < at('■ Product Team'));
    assert.ok(at('■ Product Team') < at('■ Marcus Webb'));
    assert.match(w, /■ Marcus Webb · 1:1 · broadcast · chat_id/);
  });

  it('chat headers show the nickname and unknown senders', async () => {
    const { call } = await setup();
    assert.match(text(await call('catch_up', {})), /■ Linda Carter · 1:1 · aka Mom · chat_id/);
    const all = text(await call('catch_up', { senders: 'all' }));
    assert.match(all, /■ \(555\) 555-0188 · 1:1 · not in Contacts · 1 unread/);
    assert.doesNotMatch(all, /482913/);
    assert.ok(all.includes(CODE_MARKER));
  });

  it('says how many unread messages were left out and where they start', async () => {
    const { store, call } = await setup();
    const first = store.pageChat(PRIYA, { unreadOnly: true }, { limit: 1, anchor: 'start' }).items[0];
    const t = text(await call('catch_up', { messages_per_chat: 1 }));
    assert.ok(
      t.includes(
        `■ Priya Nair · 1:1 · 2 unread · chat_id ${PRIYA}\n  … 1 earlier unread not shown · read_conversation chat=${PRIYA} after=${fmtIso(first.sentAt, TZ)}`,
      ),
    );
    const j = (await call('catch_up', { messages_per_chat: 1, format: 'json' })).structuredContent;
    const priya = j.unread.find((c: any) => c.chat_id === PRIYA);
    assert.equal(priya.unread_not_shown, 1);
    assert.equal(priya.first_unread_message_id, first.messageId);
    assert.equal(j.unread.find((c: any) => c.chat_id === SAM_LEE).unread_not_shown, undefined);
    const r = await call('read_conversation', { chat: PRIYA, after: priya.first_unread_at, format: 'json' });
    assert.equal(r.structuredContent.messages[0].message_id, first.messageId);
  });

  it('labels are normalised, and an unknown label says which ones exist', async () => {
    const { store, call } = await setup();
    const none = await call('catch_up', { label: 'trip' });
    assert.equal(none.isError, true);
    assert.match(
      text(none),
      /Error label_not_found: No conversation has label "trip"\.\nFix: No labels exist yet; add one with label_conversation\./,
    );
    store.labelChat(CABIN, ['trip'], []);
    store.setReminder(MOM, store.now() - 60_000, 'call back', 'i_reply');
    const t = text(await call('catch_up', { label: '#Trip' }));
    assert.match(t, /Unread \(1\)\n■ Cabin Weekend/);
    assert.match(t, /Reminders due \(0\)/);
    const bad = await call('catch_up', { label: 'work' });
    assert.match(text(bad), /Fix: Labels: trip \(1\)\. Ask the user which one, or use find\./);
  });

  it('lists due and upcoming reminders with dismiss_when', async () => {
    const { store, call } = await setup();
    const now = store.now();
    store.setReminder(MOM, now - 60_000, 'call back', 'i_reply');
    store.setReminder(JO, now + 3 * 3_600_000, 'ask about gas', 'they_reply');
    const t = text(await call('catch_up', {}));
    assert.match(t, /Reminders due \(1\)\n {2}⏰ Linda Carter · .* · call back · dismiss_when i_reply · chat_id/);
    assert.match(
      t,
      /Upcoming reminders \(1\)\n {2}⏰ Jo Kim · .* \(in 3 h\) · ask about gas · dismiss_when they_reply · chat_id/,
    );
    const j = (await call('catch_up', { format: 'json' })).structuredContent;
    assert.equal(j.due_reminders[0].dismiss_when, 'i_reply');
    assert.match(j.due_reminders[0].reminder_id, /^r/);
    assert.equal(j.upcoming_reminders[0].chat_id, JO);
    assert.equal(j.upcoming_reminders[0].dismiss_when, 'they_reply');
  });

  it('describes include_needs_reply and the triage rule', async () => {
    const { client } = await setup();
    const tool = (await client.listTools()).tools.find((x) => x.name === 'catch_up')!;
    assert.match(tool.description!, /groups, broadcasts and unknown senders come last/);
    assert.match(tool.description!, /due and upcoming reminders/);
    assert.match(
      (tool.inputSchema.properties as any).include_needs_reply.description,
      /Marking a chat read does not remove it; replying does/,
    );
  });
});

describe('read_conversation', () => {
  it('lists the other 1:1 threads and where an empty range has messages', async () => {
    const { store, call } = await setup();
    const month = fmtIso(firstIn(store, SAM_O_EMAIL).sentAt, TZ).slice(0, 7);
    const t = text(await call('read_conversation', { chat: 'Sam Ortiz', on: month }));
    assert.match(
      t,
      /\nAlso 1:1 with Sam Ortiz: .*iMessage;-;sam\.ortiz@example\.com \(iMessage · last [^)]*· 2 in range\)/,
    );
    assert.match(t, /SMS;-;\+15555550142 \(SMS · last [^)]*· 0 in range\)/);
    assert.match(t, /\nNo messages · .+\. This chat runs .+ – .+\./);
    const j = (await call('read_conversation', { chat: 'Sam Ortiz', on: month, format: 'json' })).structuredContent;
    assert.equal(j.other_dm_chats.length, 2);
    assert.equal(j.other_dm_chats.find((c: any) => c.chat_id === SAM_O_EMAIL).in_range, 2);
    assert.equal(j.other_dm_chats.find((c: any) => c.chat_id === SAM_O_EMAIL).via, 'sam.ortiz@example.com');
    assert.match(j.conversation_span.first_at, /^\d{4}-/);
    assert.match(j.range.after, new RegExp(`^${month}-01T00:00:00`));
    const plain = text(await call('read_conversation', { chat: 'Sam Ortiz', limit: 3 }));
    assert.match(plain, /Also 1:1 with Sam Ortiz: .*\(SMS · last [^)]*\)/);
    assert.doesNotMatch(text(await call('read_conversation', { chat: 'Sam Lee' })), /Also 1:1/);
  });

  it('echoes the resolved range and marks the start of the conversation', async () => {
    const { store, call } = await setup();
    const month = fmtIso(allIn(store, MOM)[100].sentAt, TZ).slice(0, 7);
    const label = fmtRange(resolveRange({ on: month }, TZ, store.now()), TZ, store.now());
    const t = text(await call('read_conversation', { chat: 'Mom', on: month, limit: 200 }));
    assert.ok(t.includes(`messages · ${label}`), t.split('\n')[2]);
    assert.match(
      text(await call('read_conversation', { chat: 'Sam Lee' })),
      /\n4 of 4 messages · start of conversation\n/,
    );
    const empty = text(await call('read_conversation', { chat: 'Mom', on: '1999-03' }));
    assert.match(empty, /No messages · Mon Mar 1 1999 – Wed Mar 31 1999\. This chat runs /);
  });

  it('start_from=oldest reads from the first message', async () => {
    const { store, call } = await setup();
    const j = (await call('read_conversation', { chat: 'Mom', start_from: 'oldest', limit: 3, format: 'json' }))
      .structuredContent;
    assert.equal(j.messages[0].message_id, firstIn(store, MOM).messageId);
    assert.equal(j.older_cursor, null);
    assert.ok(j.newer_cursor);
    const latest = (
      await call('read_conversation', {
        chat: 'Mom',
        after: '2000-01-01',
        start_from: 'newest',
        limit: 1,
        format: 'json',
      })
    ).structuredContent;
    assert.equal(latest.messages[0].message_id, allIn(store, MOM).at(-1)!.messageId);
  });

  it('a cursor keeps its window and from filter, so chat + cursor stays in range', async () => {
    const { store, call } = await setup();
    const month = fmtIso(allIn(store, MOM)[200].sentAt, TZ).slice(0, 7);
    const range = resolveRange({ on: month }, TZ, store.now());
    const first = (await call('read_conversation', { chat: 'Mom', on: month, from: 'me', limit: 3, format: 'json' }))
      .structuredContent;
    let cursor = first.older_cursor;
    assert.ok(cursor);
    let seen = first.messages.length;
    while (cursor) {
      const page = (await call('read_conversation', { chat: 'Mom', cursor, format: 'json' })).structuredContent;
      for (const m of page.messages) {
        assert.equal(m.from, 'me');
        const at = Date.parse(m.sent_at);
        assert.ok(at >= range.after! && at < range.before!, `${m.sent_at} outside ${month}`);
      }
      assert.equal(page.total_in_range, first.total_in_range);
      seen += page.messages.length;
      cursor = page.older_cursor;
    }
    assert.equal(seen, first.total_in_range);
  });

  it('rejects cursors from another chat or a malformed cursor with a fix that fits', async () => {
    const { call } = await setup();
    const mom = (await call('read_conversation', { chat: 'Mom', limit: 2, format: 'json' })).structuredContent;
    const other = await call('read_conversation', { chat: 'Sam Lee', cursor: mom.older_cursor });
    assert.match(
      text(other),
      /Error invalid_cursor: That cursor belongs to a different conversation\.\nFix: Pass chat="iMessage;-;\+15555550111" with it/,
    );
    const bad = await call('read_conversation', { chat: 'Mom', cursor: 'page2' });
    assert.match(
      text(bad),
      /Fix: Pass older_cursor or newer_cursor exactly as read_conversation returned it for this chat, or omit cursor to start from the latest messages\./,
    );
  });

  it('marks unread messages from others with •, aligned only when a page has some', async () => {
    const { call } = await setup();
    const t = text(await call('read_conversation', { chat: 'Sam Lee' }));
    assert.match(t, /\n• \[[^\n]*extra ticket/);
    assert.match(t, /\n {2}\[[^\n]*climbing gym/);
    const mom = text(await call('read_conversation', { chat: 'Mom', limit: 3 }));
    assert.match(mom, /\n\[[^\n]*#m\d+$/);
  });

  it('JSON is marked untrusted and schema descriptions carry the range rules', async () => {
    const { client, call } = await setup();
    const r = await call('read_conversation', { chat: 'Mom', limit: 1, format: 'json' });
    assert.equal(Object.keys(r.structuredContent)[0], 'notice');
    assert.ok(JSON.parse(r.content[0].text!).notice);
    const props = (await client.listTools()).tools.find((x) => x.name === 'read_conversation')!.inputSchema
      .properties as any;
    assert.match(props.on.description, /whole day containing it/);
    assert.match(props.before.description, /^Before \(exclusive\)/);
    assert.match(props.max_chars_per_message.description, /^50–20000\./);
    assert.deepEqual(props.start_from.enum, ['newest', 'oldest']);
  });
});

describe('get_message, get_reply_thread, get_conversation', () => {
  it('accepts #m, msg: and bare digits, and explains unknown ids', async () => {
    const { call } = await setup();
    assert.match(text(await call('get_message', { message_id: '1014' })), /▶ .*grill for the cabin/);
    assert.match(text(await call('get_message', { message_id: 'msg:m1014' })), /▶ .*grill for the cabin/);
    const thread = await call('get_reply_thread', { message_id: 'm9' });
    assert.match(text(thread), /Error message_not_found: No message has id "m9"\.\nFix: Message ids look like m1234/);
  });

  it('prints a long multi-line message once', async () => {
    const { store, call } = await setup();
    const recipe = allIn(store, MOM).find((m) => m.text.includes('apple pie recipe'))!;
    const t = text(await call('get_message', { message_id: recipe.messageId }));
    assert.match(t, /▶ .*… \[\+\d+ chars, full text below\]/);
    const tail = recipe.text.trim().slice(-30);
    assert.equal(t.split(tail).length - 1, 1);
    assert.match(t, /\nFull text:\n/);
  });

  it('attachment lines use the get_attachment facts', async () => {
    const { store, call } = await setup();
    const memo = store.listAttachments({ kinds: ['voice_memo'] }, { limit: 1, offset: 0 }).items[0];
    assert.match(
      text(await call('get_message', { message_id: memo.messageId })),
      new RegExp(`Attachment · Audio Message\\.caf · voice memo · 182 KB · 23s · attachment_id ${memo.attachmentId}$`),
    );
    const pdf = store.listAttachments({ kinds: ['pdf'], chatId: PRIYA }, { limit: 1, offset: 0 }).items[0];
    assert.match(
      text(await call('get_message', { message_id: pdf.messageId })),
      /Attachment · Q4-launch-plan\.pdf · pdf · 413 KB · attachment_id a\d+ · text: get_attachment mode=text/,
    );
  });

  it('shows bubbles and which bubble a tapback is on', async () => {
    const { store, call } = await setup();
    const photo = store.listAttachments({ nameQuery: 'IMG_4410' }, { limit: 1, offset: 0 }).items[0];
    await store.react(photo.messageId, 'love', undefined, false, 1);
    const t = text(await call('get_message', { message_id: photo.messageId }));
    assert.match(t, /\nBubbles · 0 photo IMG_4410\.JPG · 1 text\n/);
    assert.match(t, /\nReactions · ❤️ You ·part 1\n/);
    const j = (await call('get_message', { message_id: photo.messageId, format: 'json' })).structuredContent;
    assert.equal(j.message.part_count, 2);
    assert.deepEqual(j.message.parts, [
      { part: 0, kind: 'image', attachment_id: photo.attachmentId },
      { part: 1, kind: 'text' },
    ]);
    assert.equal(j.message.reactions[0].part, 1);
    assert.doesNotMatch(text(await call('get_message', { message_id: 'm1014' })), /Bubbles/);
    // a stored order wins over the files-first guess: text first, as the live store reads it
    const m = store.message(photo.messageId)!;
    m.parts = [{ kind: 'text' }, { kind: 'file', attachmentId: photo.attachmentId }];
    assert.match(
      text(await call('get_message', { message_id: photo.messageId })),
      /\nBubbles · 0 text · 1 photo IMG_4410\.JPG\n/,
    );
    // unknown order with three bubbles says so instead of guessing
    m.parts = undefined;
    m.partCount = 3;
    assert.match(
      text(await call('get_message', { message_id: photo.messageId })),
      /\nBubbles · 3 \(photo IMG_4410\.JPG, 2 text; order unknown\)\n/,
    );
    assert.equal(
      'parts' in (await call('get_message', { message_id: photo.messageId, format: 'json' })).structuredContent.message,
      false,
    );
  });

  it('an unsent message shows no edit history or edited time', async () => {
    const { store, call } = await setup();
    (store.message('m1014') as Message).unsent = true;
    const t = text(await call('get_message', { message_id: 'm1014' }));
    assert.doesNotMatch(t, /Edit history|edited/);
    const j = (await call('get_message', { message_id: 'm1014', format: 'json' })).structuredContent;
    assert.equal(j.message.edit_history, undefined);
    assert.equal(j.message.edited_at, undefined);
    assert.equal(Object.keys(j)[0], 'notice');
  });

  it('a reply-thread cursor belongs to its thread', async () => {
    const { store, call } = await setup();
    const reply = allIn(store, CABIN).find((m) => m.replyToId)!;
    const first = (await call('get_reply_thread', { message_id: reply.messageId, limit: 1, format: 'json' }))
      .structuredContent;
    assert.equal(first.reply_count, 2);
    const next = (
      await call('get_reply_thread', {
        message_id: reply.replyToId!,
        limit: 1,
        cursor: first.next_cursor,
        format: 'json',
      })
    ).structuredContent;
    assert.notEqual(next.replies[0].message_id, first.replies[0].message_id);
    assert.equal(next.next_cursor, null);
    const wrong = await call('get_reply_thread', { message_id: 'm1014', cursor: first.next_cursor });
    assert.match(text(wrong), /Error invalid_cursor: That cursor belongs to a different thread\./);
  });

  it('get_conversation: the full participant list, other threads and reminder details', async () => {
    const { store, client, call } = await setup();
    store.chat(CABIN)!.participantIds = Array.from({ length: 12 }, (_, i) => `p_extra_${i}`);
    const big = (await call('get_conversation', { chat: CABIN })).structuredContent;
    assert.equal(big.participants.length, 12);
    assert.equal(big.participant_count, 13);
    assert.equal(big.participants_omitted, undefined);
    store.setReminder(SAM_O, store.now() + 3_600_000, 'charger', 'they_reply');
    const sam = (await call('get_conversation', { chat: 'Sam Ortiz' })).structuredContent;
    assert.equal(Object.keys(sam)[0], 'notice');
    assert.deepEqual(sam.other_dm_chats.map((c: any) => c.chat_id).sort(), ['SMS;-;+15555550142', SAM_O_EMAIL]);
    assert.match(sam.reminders[0].reminder_id, /^r/);
    assert.equal(sam.reminders[0].dismiss_when, 'they_reply');
    const desc = (await client.listTools()).tools.find((x) => x.name === 'get_conversation')!.description!;
    assert.match(desc, /participants lists the other members; participant_count includes you\./);
  });
});

describe('get_updates', () => {
  it('a filtered wait ignores unrelated events, then pins its filter and moves past them', async () => {
    const { store, call } = await setup();
    const c0 = (await call('get_updates', { cursor: 'now' })).structuredContent.next_cursor;
    store.receive(MOM, 'p_linda', 'hi there');
    let t0 = Date.now();
    const r1 = (await call('get_updates', { cursor: c0, chat: 'Sam Lee', wait_seconds: 1 })).structuredContent;
    assert.ok(Date.now() - t0 >= 900, 'held the full wait');
    assert.deepEqual(r1.events, []);
    assert.ok(r1.waited_ms >= 900);
    assert.deepEqual(r1.watching.chat_ids, [SAM_LEE]);
    const p1 = cursorOf(r1.next_cursor);
    assert.equal(p1.s, cursorOf(c0).s, 'the adopting call does not skip');
    assert.deepEqual(p1.f, { c: [SAM_LEE], p: 'p_sam_lee' });
    t0 = Date.now();
    const r2 = (await call('get_updates', { cursor: r1.next_cursor, chat: 'Sam Lee', wait_seconds: 1 }))
      .structuredContent;
    assert.ok(Date.now() - t0 >= 900);
    assert.equal(cursorOf(r2.next_cursor).s, store.latestSeq(), 'a pinned cursor moves past skipped events');
    // a different filter is accepted and rescans from the cursor; what the old filter already skipped is not repeated
    const other = await call('get_updates', { cursor: r2.next_cursor, chat: 'Mom' });
    assert.equal(other.isError, undefined);
    assert.deepEqual(other.structuredContent.events, []);
    assert.deepEqual(other.structuredContent.filter_changed.previous, { chat_ids: [SAM_LEE], types: null, from: null });
    assert.match(
      other.structuredContent.filter_changed.note,
      /^This cursor was made for chat_ids iMessage;-;\+15555550177; the new filter applies from the cursor's position, so nothing pending is lost\./,
    );
    const all = (await call('get_updates', { cursor: c0 })).structuredContent;
    assert.equal(all.events[0].chat_id, MOM);
  });

  it('a matching event ends the wait at once, also from cursor=now', async () => {
    const { store, call } = await setup();
    setTimeout(() => store.receive(SAM_LEE, 'p_sam_lee', 'yo'), 150).unref();
    const t0 = Date.now();
    const r = await call('get_updates', { cursor: 'now', chat: 'Sam Lee', wait_seconds: 5 });
    assert.ok(Date.now() - t0 < 3000);
    const e = r.structuredContent.events[0];
    assert.equal(Object.keys(r.structuredContent)[0], 'notice');
    assert.equal(e.type, 'new');
    assert.equal(e.by, 'Sam Lee');
    assert.equal(e.by_person_id, 'p_sam_lee');
    assert.equal(e.is_from_me, false);
    assert.equal(e.message.text, 'yo');
    assert.equal(r.structuredContent.note, undefined);
  });

  it('a person covers all their 1:1 threads', async () => {
    const { store, call } = await setup();
    const c = (await call('get_updates', { cursor: 'now' })).structuredContent.next_cursor;
    store.receive(SAM_O_EMAIL, 'p_sam_ortiz', 'from my email');
    const r = (await call('get_updates', { cursor: c, chat: 'Sam Ortiz' })).structuredContent;
    assert.deepEqual(r.watching.chat_ids, [SAM_O, 'SMS;-;+15555550142', SAM_O_EMAIL].sort());
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].chat_id, SAM_O_EMAIL);
    assert.equal(cursorOf(r.next_cursor).f.p, 'p_sam_ortiz');
    assert.notEqual((await call('get_updates', { cursor: r.next_cursor, chat: 'p_sam_ortiz' })).isError, true);
    const one = (await call('get_updates', { cursor: c, chat: SAM_O })).structuredContent.next_cursor;
    const wider = await call('get_updates', { cursor: one, chat: 'Sam Ortiz' });
    assert.equal(wider.isError, undefined);
    assert.ok(wider.structuredContent.filter_changed);
    assert.deepEqual(
      wider.structuredContent.events.map((e: any) => e.chat_id),
      [SAM_O_EMAIL],
      'the wider filter rescans from the cursor',
    );
    // narrower (one of the person's threads) stays pinned with no note
    assert.equal(
      (await call('get_updates', { cursor: r.next_cursor, chat: SAM_O })).structuredContent.filter_changed,
      undefined,
    );
  });

  it('switching a pinned cursor to from=<person> still delivers their pending reply', async () => {
    const { store, call } = await setup();
    const pinned = (await call('get_updates', { cursor: 'now', chat: 'Jo Kim' })).structuredContent.next_cursor;
    const reply = store.receive(JO, 'p_jo', 'can I call you later?');
    const r = (await call('get_updates', { cursor: pinned, from: 'Jo Kim' })).structuredContent;
    assert.deepEqual(
      r.events.map((e: any) => e.message.message_id),
      [reply.messageId],
    );
    assert.ok(r.filter_changed);
    const t = text(await call('get_updates', { cursor: pinned, from: 'Jo Kim', format: 'transcript' }));
    assert.match(t, /can I call you later\?[\s\S]*This cursor was made for chat_ids /);
  });

  it('from filters by who caused the change and defaults to new messages; types takes one string', async () => {
    const { store, call } = await setup();
    const c = (await call('get_updates', { cursor: 'now' })).structuredContent.next_cursor;
    const lee = store.receive(SAM_LEE, 'p_sam_lee', 'are you in?');
    await store.react(lee.messageId, 'like', undefined, false);
    store.receive(MOM, 'p_linda', 'call me');
    const r = (await call('get_updates', { cursor: c, from: 'Sam Lee' })).structuredContent;
    assert.deepEqual(
      r.events.map((e: any) => e.message.message_id),
      [lee.messageId],
    );
    assert.deepEqual(r.watching, { chat_ids: null, types: ['new'], from: 'p_sam_lee', from_name: 'Sam Lee' });
    const mine = (await call('get_updates', { cursor: c, from: 'me', types: 'reaction' })).structuredContent;
    assert.equal(mine.events.length, 1);
    assert.equal(mine.events[0].by, 'me');
    assert.equal(mine.events[0].reaction, 'like');
    assert.equal(mine.events[0].is_from_me, false);
    await store.react(lee.messageId, 'like', undefined, true);
    const removed = (await call('get_updates', { cursor: mine.next_cursor, from: 'me', types: ['reaction'] }))
      .structuredContent;
    assert.equal(removed.events[0].removed, true);
  });

  it('edits carry the previous text, with codes hidden', async () => {
    const { store, call } = await setup();
    const c = (await call('get_updates', { cursor: 'now' })).structuredContent.next_cursor;
    const sent = await store.send({ chatId: SAM_LEE }, 'the door code is 482913', [], 'auto', 'read-test-edit-0001');
    await store.edit(sent.message!.messageId, 'see you at 8');
    const r = (await call('get_updates', { cursor: c, types: 'edited' })).structuredContent;
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].previous_text, `the door code is ${CODE_MARKER}`);
    assert.equal(r.events[0].is_from_me, true);
    const tr = await call('get_updates', { cursor: c, format: 'transcript' });
    assert.equal(tr.structuredContent, undefined);
    const t = text(tr);
    assert.match(t, /^⚠ /);
    assert.match(
      t,
      /\] edited · Sam Lee · You: "the door code is \[verification code hidden\]" → "see you at 8" #m\d+/,
    );
    assert.match(t, /\nnext_cursor c_\S+$/);
  });

  it('limit pages through events without losing any', async () => {
    const { store, call } = await setup();
    const c = (await call('get_updates', { cursor: 'now' })).structuredContent.next_cursor;
    for (const t of ['one', 'two', 'three']) store.receive(MOM, 'p_linda', t);
    const p1 = (await call('get_updates', { cursor: c, limit: 2 })).structuredContent;
    assert.deepEqual(
      p1.events.map((e: any) => e.message.text),
      ['one', 'two'],
    );
    assert.equal(p1.has_more, true);
    const p2 = (await call('get_updates', { cursor: p1.next_cursor, limit: 2 })).structuredContent;
    assert.deepEqual(
      p2.events.map((e: any) => e.message.text),
      ['three'],
    );
    assert.equal(p2.has_more, undefined);
  });

  it('cursors from another boot, from the future or past the buffer expire with a catch_up fix', async () => {
    const a = await setup();
    const b = await setup();
    const foreign = (await a.call('get_updates', { cursor: 'now' })).structuredContent.next_cursor;
    const r = await b.call('get_updates', { cursor: foreign });
    assert.match(
      text(r),
      /Error cursor_expired: Changes since \d{4}-\d\d-\d\dT[^ ]+ are no longer available\. The Mac's bridge restarted or the cursor is too old\.\nFix: Call catch_up with since="[^"]+" to see what you missed, then call get_updates with cursor="now"\./,
    );
    assert.match(
      text(await b.call('get_updates', { cursor: encodeCursor({ k: 'up', s: 99, b: b.store.bootId, t: Date.now() }) })),
      /cursor_expired/,
    );
    const legacy = text(await b.call('get_updates', { cursor: encodeCursor({ k: 'up', s: 0 }) }));
    assert.match(legacy, /cursor_expired: Changes since that cursor/);
    assert.doesNotMatch(legacy, /since="/);
    for (let i = 0; i < 5001; i++) b.store.receive(MOM, 'p_linda', `flood ${i}`);
    assert.match(
      text(await b.call('get_updates', { cursor: encodeCursor({ k: 'up', s: 0, b: b.store.bootId, t: Date.now() }) })),
      /cursor_expired/,
    );
  });

  it("accepts send_message's updates_cursor; bad cursors never say omit it", async () => {
    const { store, call } = await setup();
    const fromSend = encodeCursor({ k: 'up', s: store.latestSeq(), b: store.bootId, t: store.now() });
    store.receive(SAM_LEE, 'p_sam_lee', 'got it');
    const r = (await call('get_updates', { cursor: fromSend, from: 'others' })).structuredContent;
    assert.equal(r.events.length, 1);
    for (const bad of ['null', '2026-10-17T09:00', 'm1014']) {
      const t = text(await call('get_updates', { cursor: bad }));
      assert.match(
        t,
        /Error invalid_cursor: .*\nFix: Pass cursor="now" to start over, or next_cursor\/updates_cursor exactly as returned\. Times and message ids are not cursors/,
      );
      assert.doesNotMatch(t, /omit/);
    }
  });

  it('holds at most 50 s and documents it', async () => {
    const { client } = await setup();
    assert.equal(MAX_UPDATE_HOLD_S, 50);
    const tool = (await client.listTools()).tools.find((x) => x.name === 'get_updates')!;
    const props = tool.inputSchema.properties as any;
    assert.match(props.wait_seconds.description, /Held at most 50 s/);
    assert.match(tool.description!, /If your call times out, repeat it with the same cursor; no events are lost\./);
    assert.match(tool.description!, /offer set_reminder/);
    assert.equal(props.format.default, 'json');
  });
});
