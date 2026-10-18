// Store layer: MockStore behaviour and LiveStore on a throwaway fixture chat.db. Never touches the real chat.db.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { ToolError } from '../src/lib/errors.js';
import { zonedToUtc } from '../src/lib/time.js';
import { ImsgError, type ImsgStatus, type PrivateApi } from '../src/live/imsgRpc.js';
import { LiveStore } from '../src/live/liveStore.js';
import { ftsQueryAny } from '../src/live/sidecar.js';
import type { MockStore } from '../src/mock/mockStore.js';
import { MAX_FILE_BYTES } from '../src/relay/protocol.js';
import { idempotencyConflict, inProgressError, sendFingerprint } from '../src/store/idempotency.js';
import { stemWord, termHits, textTerms, wordTokens } from '../src/store/match.js';
import type { MessageStore } from '../src/store/ports.js';
import { fillStatRows, groupStats } from '../src/store/stats.js';
import { ME } from '../src/store/types.js';
import { PLIST } from './fixtures/blobs.js';
import { appleNs, createAddressBook, createChatDb, fixtureBridgeConfig } from './helpers/chatdb.js';
import { makeCtx } from './helpers/ctx.js';
import { connectTools, errCode, text } from './helpers/mcp.js';
import { newMockStore } from './helpers/mock.js';
import { encodeAttributedBody as body } from './helpers/typedstream.js';
import { waitFor } from './helpers/wait.js';

const TZ = 'America/New_York';
const mock = (o: { redactCodes?: boolean } = {}) => newMockStore(o);
const code = (c: string) => (e: unknown) => e instanceof ToolError && e.code === c;
const byText = (s: MockStore, t: string | RegExp) =>
  s
    .listMessages({ includeSystem: true }, { order: 'asc', limit: 5000, offset: 0 })
    .items.find((m) => (typeof t === 'string' ? m.text === t : t.test(m.text)))!;

describe('MockStore', () => {
  it('replays a same-key send, rejects a key reused for a different message, and never caches a retry-safe failure', async () => {
    const s = mock();
    const a = await s.send({ chatId: 'iMessage;-;+15555550142' }, 'found your charger!', [], 'auto', 'k1');
    assert.equal(a.disposition, 'delivered');
    const again = await s.send({ address: '(555) 555-0142' }, ' found your charger! ', [], 'auto', 'k1');
    assert.equal(again.replayed, true);
    assert.equal(again.message?.messageId, a.message?.messageId);
    await assert.rejects(
      s.send({ chatId: 'iMessage;-;+15555550177' }, 'found your charger!', [], 'auto', 'k1'),
      (e: unknown) =>
        e instanceof ToolError &&
        e.code === 'idempotency_conflict' &&
        e.message.includes(`DELIVERED → Sam Ortiz · #${a.message!.messageId}`) &&
        !e.message.includes('charger') &&
        !!e.fix,
    );
    await assert.rejects(
      s.send({ chatId: 'iMessage;-;+15555550142' }, 'found your charger?', [], 'auto', 'k1'),
      code('idempotency_conflict'),
    );
    const f1 = await s.send({ address: '+15555550000' }, 'test', [], 'auto', 'k2');
    const f2 = await s.send({ address: '+15555550000' }, 'test', [], 'auto', 'k2');
    assert.equal(f1.disposition, 'failed');
    assert.equal(f1.retrySafe, true);
    assert.equal(f2.replayed, undefined);
    assert.notEqual(f2.message?.messageId, f1.message?.messageId);
  });

  it('fingerprints a DM the same by chat_id or address and a group by chat_id; builds in_progress', () => {
    const s = mock();
    assert.equal(
      sendFingerprint(s, { chatId: 'iMessage;-;+15555550142' }, 'hi', []),
      sendFingerprint(s, { address: '555-555-0142' }, 'hi ', []),
    );
    assert.notEqual(
      sendFingerprint(s, { chatId: 'iMessage;+;chat58213' }, 'hi', []),
      sendFingerprint(s, { chatId: 'iMessage;+;chat71940' }, 'hi', []),
    );
    assert.notEqual(
      sendFingerprint(s, { chatId: 'iMessage;-;+15555550142' }, 'hi', []),
      sendFingerprint(s, { chatId: 'iMessage;-;+15555550142' }, 'hi', [
        { filename: 'a.png', mime: 'image/png', sourceAttachmentId: 'a104' },
      ]),
    );
    assert.equal(
      sendFingerprint(s, { chatId: 'iMessage;-;+15555550142' }, 'hi', [], { replyTo: '#m1' }),
      sendFingerprint(s, { chatId: 'iMessage;-;+15555550142' }, 'hi', [], { replyTo: 'm1' }),
    );
    assert.equal(inProgressError().code, 'in_progress');
    assert.match(inProgressError().fix!, /same idempotency_key/);
    assert.match(idempotencyConflict().message, /already used for a different message\. Nothing new was sent\./);
  });

  it('forwards attachments by id, reports per-file outcomes and partial sends', async () => {
    const s = mock();
    const r = await s.send(
      { chatId: 'iMessage;-;+15555550142' },
      'packing list',
      [{ filename: 'IMG_4410.JPG', mime: 'image/jpeg', sourceAttachmentId: 'a104' }],
      'auto',
      'f1',
    );
    const att = s.attachment(r.message!.attachmentIds[0])!;
    assert.equal(att.kind, 'image');
    assert.equal(att.bytes, s.attachment('a104')!.bytes);
    assert.ok(att.dataBase64);
    assert.equal(att.extractedText, s.attachment('a104')!.extractedText);
    assert.deepEqual(r.attachments, [
      { filename: 'IMG_4410.JPG', messageId: r.message!.messageId, status: 'delivered' },
    ]);
    assert.equal(r.message!.partCount, 2);
    await assert.rejects(
      s.send(
        { chatId: 'iMessage;-;+15555550142' },
        'x',
        [{ filename: 'x', mime: 'image/png', sourceAttachmentId: 'a999999' }],
        'auto',
        'f2',
      ),
      code('attachment_not_found'),
    );
    const partial = await s.send(
      { chatId: 'iMessage;-;+15555550142' },
      'signed, see attached',
      [{ filename: 'lease.pdf', mime: 'application/pdf', url: 'https://x.example/fail.pdf' }],
      'auto',
      'f3',
    );
    assert.equal(partial.disposition, 'may_have_completed');
    assert.equal(partial.retrySafe, false);
    assert.equal(partial.error?.code, 'attachment_failed');
    assert.ok(partial.error?.fix);
    assert.deepEqual(partial.attachments, [
      { filename: 'lease.pdf', messageId: null, status: 'failed', error: 'attachment_failed' },
    ]);
    assert.equal(partial.message?.attachmentIds.length, 0);
    const nothing = await s.send(
      { chatId: 'iMessage;-;+15555550142' },
      '',
      [{ filename: 'lease.pdf', mime: 'application/pdf', url: 'https://x.example/fail.pdf' }],
      'auto',
      'f4',
    );
    assert.equal(nothing.disposition, 'failed');
    assert.equal(nothing.retrySafe, true);
    assert.equal(nothing.message, undefined);
    const bounced = await s.send(
      { address: '+15555550000' },
      'x',
      [{ filename: 'p.png', mime: 'image/png', base64: 'AAAA' }],
      'auto',
      'f5',
    );
    assert.equal(bounced.attachments?.[0].status, 'failed');
  });

  it('routes an explicit service to that thread for 1:1 chats and ignores it for groups', async () => {
    const s = mock();
    const sms = await s.send({ chatId: 'iMessage;-;+15555550142' }, 'green bubble', [], 'SMS', 's1');
    assert.equal(sms.chatId, 'SMS;-;+15555550142');
    assert.equal(sms.message?.service, 'SMS');
    const g = await s.send({ chatId: 'iMessage;+;chat58213' }, 'hi all', [], 'SMS', 's2');
    assert.equal(g.chatId, 'iMessage;+;chat58213');
    assert.equal(g.message?.service, 'iMessage');
  });

  it('edits with trimmed text and the previous text on the event; unsend clears the edit history', async () => {
    const s = mock();
    const ok = await s.send({ chatId: 'iMessage;-;+15555550142' }, 'see you at 7', [], 'auto', 'e2');
    const before = s.latestSeq();
    const edited = await s.edit(ok.message!.messageId, '  see you at 8  ');
    assert.equal(edited.text, 'see you at 8');
    assert.deepEqual(
      s.updatesSince(before).map((e) => [e.type, e.actorId, e.previousText]),
      [['edited', ME, 'see you at 7']],
    );
    const unsent = await s.unsend(ok.message!.messageId);
    assert.equal(unsent.unsent, true);
    assert.equal(unsent.editedAt, undefined);
    assert.equal(unsent.editHistory, undefined);
  });

  it('keeps tapbacks per part, removes only the named kind, and reports the actor', async () => {
    const s = mock();
    const m = byText(s, 'packing list so far');
    assert.equal(m.partCount, 2);
    await s.react(m.messageId, 'love', undefined, false, 0);
    await s.react(m.messageId, 'laugh', undefined, false, 1);
    assert.deepEqual(
      m.reactions.filter((r) => r.by === ME).map((r) => [r.kind, r.part ?? 0]),
      [
        ['love', 0],
        ['laugh', 1],
      ],
    );
    await s.react(m.messageId, 'like', undefined, true, 0);
    assert.equal(m.reactions.filter((r) => r.by === ME).length, 2);
    const seq = s.latestSeq();
    await s.react(m.messageId, 'laugh', undefined, true, 1);
    assert.deepEqual(
      m.reactions.filter((r) => r.by === ME).map((r) => r.kind),
      ['love'],
    );
    assert.deepEqual(
      s.updatesSince(seq).map((e) => [e.actorId, e.reaction]),
      [[ME, { kind: 'laugh', removed: true }]],
    );
  });

  it('counts mark-unread as a change only when the latest incoming message was read', async () => {
    const s = mock();
    assert.equal(await s.markRead('iMessage;-;+15555550177', true), 0);
    assert.equal(await s.markRead('iMessage;-;+15555550177', false), 1);
    assert.equal(await s.markRead('iMessage;-;+15555550177', true), 1);
    assert.equal(await s.markRead('iMessage;-;+15555550177', true), 0);
  });

  it('stops needing a reply once the owner tapbacks the last message', async () => {
    const s = mock();
    assert.equal(s.summarizeChat('iMessage;-;+15555550177').needsReply, true);
    await s.react(s.summarizeChat('iMessage;-;+15555550177').lastMessage!.messageId, 'like', undefined, false);
    assert.equal(s.summarizeChat('iMessage;-;+15555550177').needsReply, false);
  });

  it('manages groups: former titles, membership checks, iMessage-only members, addresses', async () => {
    const s = mock();
    const cabin = 'iMessage;+;chat58213';
    await s.manageGroup('rename', { chatId: cabin, title: 'Lake House' });
    assert.deepEqual(s.chat(cabin)!.formerTitles, ['Cabin Weekend 🏔️']);
    const ev = s.chatActivity(cabin).groupEvents.at(-1)!;
    assert.deepEqual(ev.system, {
      type: 'renamed',
      detail: 'named the conversation "Lake House"',
      title: 'Lake House',
    });
    await s.manageGroup('rename', { chatId: cabin, title: '' });
    assert.equal(s.chat(cabin)!.displayName, null);
    assert.deepEqual(s.chat(cabin)!.formerTitles, ['Lake House', 'Cabin Weekend 🏔️']);
    const events = s.chatActivity(cabin).groupEvents.length;
    await s.manageGroup('add', { chatId: cabin, personId: 'p_jo' });
    assert.equal(s.chatActivity(cabin).groupEvents.length, events);
    await assert.rejects(s.manageGroup('remove', { chatId: cabin, personId: 'p_priya' }), code('not_a_member'));
    await assert.rejects(
      s.manageGroup('add', { chatId: cabin, personId: 'p_marcus' }),
      (e: unknown) => e instanceof ToolError && e.code === 'not_imessage' && /Marcus Webb/.test(e.message),
    );
    await assert.rejects(s.manageGroup('add', { chatId: cabin, address: '28734' }), code('not_imessage'));
    const g = await s.manageGroup('create', {
      participantIds: ['p_sam_ortiz'],
      participantAddresses: ['+1 (555) 555-0123'],
    });
    assert.equal(g.participantIds.length, 2);
    assert.equal(s.person(g.participantIds[1])!.name, null);
    await s.manageGroup('add', { chatId: g.chatId, address: '+15555550124' });
    assert.equal(s.chat(g.chatId)!.participantIds.length, 3);
  });

  it('titles unnamed groups with First L. when first names repeat', async () => {
    const s = mock();
    const g = await s.manageGroup('create', { participantIds: ['p_sam_ortiz', 'p_sam_lee', 'p_jo'] });
    assert.equal(s.chatTitle(g), 'Sam O., Sam L., Jo');
    assert.equal(s.chatTitle(s.chat('iMessage;+;chat71940')!), 'Linda, Emma');
  });

  it('normalizes labels and dedupes aliases case-insensitively', () => {
    const s = mock();
    const p = s.updatePerson('p_marcus', {
      addAliases: ['my landlord', 'My Landlord', 'Marcus W'],
      addLabels: ['#Landlord', 'landlord', ' Work '],
    });
    assert.deepEqual(p.aliases, ['my landlord', 'Marcus W']);
    assert.deepEqual(p.labels, ['landlord', 'work']);
    assert.deepEqual(
      s.updatePerson('p_marcus', { removeLabels: ['#LANDLORD'], removeAliases: ['MY LANDLORD'] }).labels,
      ['work'],
    );
  });

  it('dismisses reminders by dismiss_when, and keeps the boolean form', async () => {
    const s = mock();
    const r = s.setReminder('iMessage;-;+15555550177', s.now() + 3_600_000, 'reply about the show', 'i_reply')!;
    assert.equal(r.dismissWhen, 'i_reply');
    assert.equal(r.dismissOnReply, false);
    assert.equal(
      s.setReminder('iMessage;-;+15555550142', s.now() + 3_600_000, undefined, true)!.dismissWhen,
      'they_reply',
    );
    s.setReminder('iMessage;-;+15555550133', s.now() + 3_600_000, undefined, 'never');
    await new Promise((res) => setTimeout(res, 5));
    s.receive('iMessage;-;+15555550177', 'p_sam_lee', 'still want the ticket?');
    s.receive('iMessage;-;+15555550133', 'p_jo', 'hello');
    assert.deepEqual(
      s
        .reminders()
        .map((x) => x.chatId)
        .sort(),
      ['iMessage;-;+15555550133', 'iMessage;-;+15555550142', 'iMessage;-;+15555550177'],
    );
    s.receive('iMessage;-;+15555550142', 'p_sam_ortiz', 'ping');
    await s.send({ chatId: 'iMessage;-;+15555550177' }, 'yes please!', [], 'auto', 'r1');
    assert.deepEqual(
      s.reminders().map((x) => x.chatId),
      ['iMessage;-;+15555550133'],
    );
  });

  it('stores draft extras and files, counts failed attempts, resets failed drafts and refuses empty ones', async () => {
    const s = mock();
    const reply = byText(s, 'are we still on for dinner saturday?').messageId;
    const d = s.createDraft({
      chatId: 'iMessage;-;+15555550142',
      text: 'see attached',
      attachmentNames: [],
      replyTo: reply,
      effect: 'confetti',
      confirmed: true,
      attachments: [{ filename: 'IMG_4410.JPG', mime: 'image/jpeg', sourceAttachmentId: 'a104' }],
    });
    assert.deepEqual([d.status, d.attempts, d.attachmentNames], ['draft', 0, ['IMG_4410.JPG']]);
    const r = await s.sendDraft(d.draftId);
    assert.equal(r.disposition, 'delivered');
    assert.equal(r.message?.replyToId, reply);
    assert.equal(r.message?.effect, 'confetti');
    assert.equal(r.message?.attachmentIds.length, 1);
    await assert.rejects(
      s.sendDraft(d.draftId),
      (e: unknown) =>
        e instanceof ToolError &&
        e.code === 'already_sent' &&
        e.message.includes(`#${r.message!.messageId}`) &&
        /edit_message/.test(e.fix!),
    );
    const bad = s.createDraft({
      chatId: null,
      toAddress: '+15555550000',
      text: 'hello?',
      attachmentNames: [],
      sendAt: s.now() + 60_000,
    });
    assert.equal(bad.status, 'scheduled');
    const f1 = await s.sendDraft(bad.draftId);
    assert.equal(f1.disposition, 'failed');
    assert.deepEqual(
      [
        s.drafts().find((x) => x.draftId === bad.draftId)!.status,
        s.drafts().find((x) => x.draftId === bad.draftId)!.attempts,
        s.drafts().find((x) => x.draftId === bad.draftId)!.error,
      ],
      ['failed', 1, 'not_delivered'],
    );
    const reset = s.updateDraft(bad.draftId, { note: 'retry later', confirmed: true });
    assert.deepEqual(
      [reset.status, reset.error, reset.sentMessageId, reset.note, reset.confirmed],
      ['scheduled', undefined, undefined, 'retry later', true],
    );
    await s.sendDraft(bad.draftId);
    assert.equal(s.drafts().find((x) => x.draftId === bad.draftId)!.attempts, 2);
    assert.equal(s.markDraftFailed(bad.draftId, 'missed_window').error, 'missed_window');
    assert.equal(s.updateDraft(bad.draftId, { sendAt: s.now() - 1000 }).status, 'draft');
    const blank = s.createDraft({ chatId: 'iMessage;-;+15555550142', text: '   ', attachmentNames: [] });
    const e = await s.sendDraft(blank.draftId);
    assert.equal(e.error?.code, 'empty_message');
    assert.equal(s.drafts().find((x) => x.draftId === blank.draftId)!.status, 'failed');
  });

  it('matches search terms on word starts like FTS5, supports match=any, and never indexes hidden code digits', async () => {
    const s = mock();
    const total = (text: string, match?: 'all' | 'any', st = s) =>
      st.search({ text }, { sort: 'relevance', limit: 50, offset: 0, match }).total;
    assert.equal(total('abin'), 0);
    assert.ok(total('cabin') > 0);
    assert.match(
      s.search({ text: "who's driving" }, { sort: 'relevance', limit: 5, offset: 0 }).items[0].text,
      /who's driving\?/,
    );
    assert.equal(total('cabins booked'), 0);
    const any = s.search({ text: 'cabins booked' }, { sort: 'relevance', limit: 50, offset: 0, match: 'any' });
    assert.ok(any.items.some((m) => m.text.startsWith('booked!!')));
    assert.ok(total('groceries', 'any') > 0);
    assert.equal(total('482913'), 0);
    assert.ok(total('verification code') >= 2);
    assert.equal(total('482913', 'all', mock({ redactCodes: false })), 1);
    assert.equal(total('"weekend cabin"'), 0);
    assert.equal(total('"cabin weekend"'), 1);
    assert.ok(total('"a frame"') > 0);
  });

  it('matches link words in any order and link domains by host or subdomain', () => {
    const s = mock();
    const links = (f: { linkQuery?: string; linkDomain?: string }) =>
      s.listMessages({ hasLink: true, ...f }, { order: 'desc', limit: 50, offset: 0 }).items.map((m) => m.link!.site);
    assert.deepEqual(links({ linkQuery: 'cabin lakeside' }), ['stays.example']);
    assert.deepEqual(links({ linkDomain: 'example.com' }), ['figma.example.com']);
    assert.deepEqual(links({ linkDomain: 'https://www.Stays.Example/rooms' }), ['stays.example']);
    assert.deepEqual(links({ linkDomain: 'stays.com' }), []);
    assert.equal(s.listAttachments({ nameQuery: 'renewal lease' }, { limit: 10, offset: 0 }).total, 1);
  });

  it('adds 1:1, group and last-message figures to person activity', async () => {
    const s = mock();
    const a = s.personActivity('p_sam_ortiz');
    assert.equal(a.dmMessageCount! + a.sentByThemInGroups!, a.messageCount);
    assert.ok(a.sentByThemInGroups! > 0);
    assert.equal(a.lastFromThem?.text, 'also did you ever find the charger I left at your place?');
    assert.equal(a.lastFromMe?.text, 'sending now');
    await s.send({ chatId: 'iMessage;+;chat58213' }, 'group hello', [], 'auto', 'pa1');
    assert.equal(s.personActivity('p_sam_ortiz').lastFromMe?.text, 'sending now');
  });

  it('keeps an explicit from in stats and gives your group messages their own row', () => {
    const s = mock();
    const fromLee = s.stats('chat', 'sent', { from: { kind: 'person', personId: 'p_sam_lee' } });
    assert.equal(
      fromLee.reduce((n, r) => n + r.value, 0),
      s.listMessages({ from: { kind: 'person', personId: 'p_sam_lee' } }, { order: 'asc', limit: 1, offset: 0 }).total,
    );
    const rows = s.stats('person', 'messages', {});
    const me = rows.find((r) => r.key === ME)!;
    assert.equal(me.label, 'You (group chats)');
    assert.equal(
      me.value,
      s.listMessages({ from: { kind: 'me' }, chatType: 'group' }, { order: 'asc', limit: 1, offset: 0 }).total,
    );
    assert.equal(
      rows.reduce((n, r) => n + r.value, 0),
      s.listMessages({}, { order: 'asc', limit: 1, offset: 0 }).total,
    );
  });

  it('exposes bootId, oldestSeq, senderAddress, partCount and the seed changes', async () => {
    const s = mock();
    assert.match(s.bootId, /^[0-9a-f]{8}$/);
    assert.notEqual(s.bootId, mock().bootId);
    assert.equal(s.oldestSeq(), 1);
    s.receive('iMessage;+;chat58213', 'p_jo', 'hi');
    assert.equal(s.oldestSeq(), 1);
    assert.equal(s.updatesSince(0)[0].actorId, 'p_jo');
    assert.equal(byText(s, 'are we still on for dinner saturday?').senderAddress, '+15555550142');
    assert.equal(byText(s, 'testing if this goes to your email').senderAddress, 'sam.ortiz@example.com');
    assert.equal(byText(s, "who's driving?").senderAddress, '+15555550133');
    assert.equal(byText(s, 'omg yes book it').senderAddress, undefined);
    assert.equal(byText(s, 'agenda attached').partCount, 2);
    const memo = s.listAttachments({ kinds: ['voice_memo'] }, { limit: 1, offset: 0 }).items[0];
    assert.equal(memo.extractedText, undefined);
    assert.equal(s.listAttachments({ kinds: ['video'] }, { limit: 1, offset: 0 }).items[0].extractedText, undefined);
    assert.ok(s.listAttachments({ kinds: ['video'] }, { limit: 1, offset: 0 }).items[0].bytes > MAX_FILE_BYTES);
    assert.equal(MAX_FILE_BYTES, 18_825_216);
    assert.equal(s.chat('iMessage;+;chat58213')!.formerTitles, undefined);
  });
});

describe('store helpers', () => {
  it('stems and tokenizes like the FTS index', () => {
    assert.deepEqual(['cabins', 'groceries', 'booking', 'booked', 'boxes', 'glass', 'bus', 'red'].map(stemWord), [
      'cabin',
      'grocery',
      'book',
      'book',
      'box',
      'glass',
      'bus',
      'red',
    ]);
    assert.deepEqual(wordTokens("Lucía's A-frame"), ['lucia', 's', 'a', 'frame']);
    assert.equal(termHits(wordTokens('the cabin'), textTerms('abin')[0]), 0);
    assert.equal(termHits(wordTokens("who's driving"), textTerms("who's")[0]), 1);
    assert.equal(ftsQueryAny('cabins "lake house" go'), '"cabin"* OR "lake house" OR "go"');
  });

  it('zero-fills hours, weekdays and months and flags cut months', () => {
    assert.equal(fillStatRows([{ key: '09', label: '09:00', value: 4 }], 'hour', { from: 0, to: 0 }, TZ).length, 24);
    const wd = fillStatRows([{ key: '3', label: 'Wed', value: 2 }], 'weekday', { from: 0, to: 0 }, TZ);
    assert.deepEqual(
      wd.map((r) => r.value),
      [0, 0, 0, 2, 0, 0, 0],
    );
    const from = zonedToUtc(2026, 3, 15, 10, 0, TZ),
      june = zonedToUtc(2026, 6, 1, 0, 0, TZ);
    const months = fillStatRows([{ key: '2026-04', label: '2026-04', value: 7 }], 'month', { from, to: june }, TZ);
    assert.deepEqual(
      months.map((r) => [r.key, r.value, !!r.partial]),
      [
        ['2026-03', 0, true],
        ['2026-04', 7, false],
        ['2026-05', 0, false],
      ],
    );
    const cut = fillStatRows(
      [],
      'month',
      { from: zonedToUtc(2026, 3, 1, 0, 0, TZ), to: zonedToUtc(2026, 5, 10, 0, 0, TZ) },
      TZ,
    );
    assert.deepEqual(
      cut.map((r) => [r.key, !!r.partial]),
      [
        ['2026-03', false],
        ['2026-04', false],
        ['2026-05', true],
      ],
    );
    const noFrom = fillStatRows(
      [
        { key: '2026-01', label: '2026-01', value: 1 },
        { key: '2026-03', label: '2026-03', value: 1 },
      ],
      'month',
      { from: 0, to: zonedToUtc(2026, 4, 1, 0, 0, TZ) },
      TZ,
    );
    assert.deepEqual(
      noFrom.map((r) => [r.key, r.value, !!r.partial]),
      [
        ['2026-01', 1, false],
        ['2026-02', 0, false],
        ['2026-03', 1, false],
      ],
    );
    assert.deepEqual(fillStatRows([], 'month', { from: 0, to: Date.now() }, TZ), []);
    assert.deepEqual(
      groupStats(
        [
          { senderId: ME, chatId: 'g', chatType: 'group', sentAt: 0 },
          { senderId: ME, chatId: 'd', chatType: 'dm', dmPartner: 'p1', sentAt: 0 },
        ],
        'person',
        TZ,
        (id) => id,
        (id) => id,
      ).map((r) => [r.key, r.label]),
      [
        [ME, 'You (group chats)'],
        ['p1', 'p1'],
      ],
    );
  });
});

// ------------------------------------------------------------------ LiveStore on a fixture chat.db
describe('LiveStore on a fixture chat.db', () => {
  let dir: string, chatDbPath: string, store: LiveStore;
  // The store's sender and Private API forward to these, so each test installs its own fake.
  let sendImpl: MessageStore['send'] = async () => {
    throw new Error('no sender installed in this test');
  };
  let helper: PrivateApi | undefined;
  const viaHelper: PrivateApi = {
    status: () => helper!.status(),
    call: (method, params) => helper!.call(method, params),
  };
  const ids: Record<string, string> = {};
  const NOW = Date.now();
  let rowid = 0;
  const write = (fn: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(chatDbPath);
    try {
      fn(db);
    } finally {
      db.close();
    }
  };
  const insert = (
    db: DatabaseSync,
    chat: number,
    handle: number,
    mine: boolean,
    at: number,
    text: string | null,
    o: Record<string, any> = {},
  ) => {
    rowid = Math.max(rowid, Number((db.prepare('select coalesce(max(ROWID), 0) r from message').get() as any).r)) + 1;
    const guid = `G-${rowid}`;
    db.prepare(`insert into message (ROWID, guid, attributedBody, handle_id, is_from_me, service, date, date_edited, is_read, item_type, group_title, associated_message_guid, associated_message_type,
      cache_has_attachments, balloon_bundle_id, message_summary_info, payload_data, error, is_delivered) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
      rowid,
      guid,
      text === null ? null : body(text),
      handle,
      mine ? 1 : 0,
      o.service ?? 'iMessage',
      appleNs(at),
      o.edited ?? 0,
      o.read ?? 1,
      o.itemType ?? 0,
      o.groupTitle ?? null,
      o.assocGuid ?? null,
      o.assocType ?? 0,
      o.att ? 1 : 0,
      o.balloon ?? null,
      o.summary ?? null,
      o.payload ?? null,
      o.error ?? 0,
    );
    db.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (?, ?, ?)').run(
      chat,
      rowid,
      appleNs(at),
    );
    return { rowid, guid, id: `m${rowid}` };
  };
  const min = (n: number) => NOW - n * 60_000;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'imsg-store-'));
    chatDbPath = join(dir, 'chat.db');
    createAddressBook(dir, [
      { first: 'Sam', last: 'Ortiz', phones: ['(555) 555-0142'] },
      { first: 'Sam', last: 'Lee', phones: ['555-555-0177'] },
      { first: 'Jo', last: 'Kim', phones: ['555-555-0133'] },
    ]);
    createChatDb(chatDbPath).close();
    // A sidecar from before the draft columns existed: the store must migrate it in place.
    mkdirSync(join(dir, 'data'));
    const old = new DatabaseSync(join(dir, 'data', 'sidecar.db'));
    old.exec(
      "CREATE TABLE drafts (id TEXT PRIMARY KEY, chat_id TEXT, to_address TEXT, text TEXT NOT NULL, send_at INTEGER, note TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, sent_message_id TEXT); INSERT INTO drafts VALUES ('dold', 'any;-;+15555550142', NULL, 'from an older bridge', NULL, NULL, 'draft', 1, NULL);",
    );
    old.close();

    write((db) => {
      const h = db.prepare('insert into handle (ROWID, id, service) values (?, ?, ?)');
      h.run(1, '+15555550142', 'iMessage');
      h.run(2, '+15555550177', 'iMessage');
      h.run(3, '+15555550133', 'iMessage');
      h.run(4, '28734', 'SMS');
      h.run(5, '+15555550142', 'SMS');
      const c = db.prepare(
        'insert into chat (ROWID, guid, style, chat_identifier, service_name, display_name) values (?, ?, ?, ?, ?, ?)',
      );
      c.run(1, 'any;-;+15555550142', 45, '+15555550142', 'iMessage', null);
      c.run(2, 'any;-;+15555550177', 45, '+15555550177', 'iMessage', null);
      c.run(3, 'any;+;chat900', 43, 'chat900', 'iMessage', 'Lake House');
      c.run(4, 'any;+;chat901', 43, 'chat901', 'iMessage', null);
      c.run(5, 'any;-;28734', 45, '28734', 'SMS', null);
      c.run(6, 'SMS;-;+15555550142', 45, '+15555550142', 'SMS', null);
      const chj = db.prepare('insert into chat_handle_join (chat_id, handle_id) values (?, ?)');
      chj.run(1, 1);
      chj.run(2, 2);
      chj.run(3, 1);
      chj.run(3, 2);
      chj.run(3, 3);
      chj.run(4, 1);
      chj.run(4, 2);
      chj.run(5, 4);
      chj.run(6, 5);

      ids.sat = insert(db, 1, 1, false, min(300), 'are we still on for saturday?').id;
      ids.oldMine = insert(db, 1, 0, true, min(290), 'yes, 7pm').id;
      const link = insert(db, 1, 1, false, min(280), 'https://www.stays.example/rooms/48213', {
        balloon: 'com.apple.messages.URLBalloonProvider',
        payload: PLIST.linkStays,
      });
      ids.link = link.id;
      const photos = insert(db, 1, 0, true, min(270), `${'\uFFFC'.repeat(5)}five photos`, { att: true });
      ids.photos = photos.id;
      for (let i = 1; i <= 5; i++) {
        db.prepare(
          "insert into attachment (ROWID, guid, original_guid, filename, mime_type, uti, transfer_name, total_bytes) values (?, ?, ?, ?, 'image/jpeg', 'public.jpeg', ?, 100)",
        ).run(i, `A-${i}`, `A-${i}`, join(dir, `IMG_${i}.JPG`), `IMG_${i}.JPG`);
        db.prepare('insert into message_attachment_join (message_id, attachment_id) values (?, ?)').run(
          photos.rowid,
          i,
        );
      }
      // Text first, then a photo; and text-photo-text: bubble order follows the placeholders.
      ids.textFirst = insert(db, 1, 1, false, min(265), 'look at this \uFFFC', { att: true }).id;
      db.prepare(
        "insert into attachment (ROWID, guid, original_guid, filename, mime_type, uti, transfer_name, total_bytes) values (6, 'A-6', 'A-6', ?, 'image/jpeg', 'public.jpeg', 'IMG_6.JPG', 100)",
      ).run(join(dir, 'IMG_6.JPG'));
      db.prepare('insert into message_attachment_join (message_id, attachment_id) values (?, 6)').run(
        Number(ids.textFirst.slice(1)),
      );
      ids.sandwich = insert(db, 1, 1, false, min(264), 'before \uFFFC after', { att: true }).id;
      db.prepare(
        "insert into attachment (ROWID, guid, original_guid, filename, mime_type, uti, transfer_name, total_bytes) values (7, 'A-7', 'A-7', ?, 'image/jpeg', 'public.jpeg', 'IMG_7.JPG', 100)",
      ).run(join(dir, 'IMG_7.JPG'));
      db.prepare('insert into message_attachment_join (message_id, attachment_id) values (?, 7)').run(
        Number(ids.sandwich.slice(1)),
      );
      insert(db, 1, 1, false, min(269), null, { assocGuid: `p:0/${photos.guid}`, assocType: 2000 });
      insert(db, 1, 1, false, min(268), null, { assocGuid: `p:1/${photos.guid}`, assocType: 2003 });
      insert(db, 1, 1, false, min(267), null, { assocGuid: `p:5/${photos.guid}`, assocType: 2004 });
      insert(db, 1, 1, false, min(266), null, { assocGuid: `p:1/${photos.guid}`, assocType: 3003 });
      ids.failed = insert(db, 1, 0, true, min(5), 'did this go?', { error: 22 }).id;
      ids.unsent = insert(db, 1, 0, true, min(4), null, {
        edited: appleNs(min(3.5)),
        summary: PLIST.unsent,
      }).id;
      ids.call = insert(db, 1, 1, false, min(3), 'call me when you can').id;
      // Sam Lee wrote last, and the owner tapbacked it.
      const gym = insert(db, 2, 2, false, min(10), 'see you at the gym?');
      ids.gym = gym.id;
      insert(db, 2, 0, true, min(9), null, { assocGuid: `p:0/${gym.guid}`, assocType: 2001 });
      // A renamed group, an unnamed one with two Sams, a bank code and an SMS thread.
      insert(db, 3, 1, false, min(500), null, { itemType: 2, groupTitle: 'Cabin Trip' });
      insert(db, 3, 2, false, min(400), null, { itemType: 2, groupTitle: 'Lake House' });
      insert(db, 3, 3, false, min(200), 'who brings snacks?');
      insert(db, 3, 0, true, min(199), 'me!');
      insert(db, 3, 1, false, min(198), 'I have the grill');
      insert(db, 4, 2, false, min(100), 'two sams in here');
      insert(db, 5, 4, false, min(50), 'Northwind Bank: Your verification code is 482913. It expires in 10 minutes.', {
        service: 'SMS',
      });
      ids.sms = insert(db, 6, 0, true, min(2), 'sms note', { service: 'SMS' }).id;
    });
    writeFileSync(join(dir, 'IMG_1.JPG'), 'jpeg');
    const cfg = fixtureBridgeConfig(dir);
    store = new LiveStore(cfg, {
      sender:
        () =>
        (...a) =>
          sendImpl(...a),
      privateApi: viaHelper,
    });
    store.start();
    await waitFor(() => store.indexStatus().ready, 'the search index to build');
  });
  after(() => {
    store?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const samO = () => store.people().find((p) => p.name === 'Sam Ortiz')!.personId;
  const samL = () => store.people().find((p) => p.name === 'Sam Lee')!.personId;
  const jo = () => store.people().find((p) => p.name === 'Jo Kim')!.personId;

  it('folds tapbacks per part, honoring removals on that part only, and counts bubbles', () => {
    const m = store.message(ids.photos)!;
    assert.equal(m.partCount, 6);
    assert.deepEqual(m.reactions.map((r) => [r.kind, r.part ?? 0]).sort(), [
      ['emphasize', 5],
      ['love', 0],
    ]);
    assert.equal(store.message(ids.sat)!.partCount, 1);
    assert.equal(store.message(ids.link)!.partCount, 1);
    assert.deepEqual(
      m.parts!.map((p) => p.kind),
      ['file', 'file', 'file', 'file', 'file', 'text'],
    );
    const tf = store.message(ids.textFirst)!;
    assert.deepEqual(tf.parts, [{ kind: 'text' }, { kind: 'file', attachmentId: tf.attachmentIds[0] }]);
    assert.deepEqual(
      store.message(ids.sandwich)!.parts!.map((p) => p.kind),
      ['text', 'file', 'text'],
    );
    assert.equal(store.message(ids.sandwich)!.partCount, 3);
    assert.equal(store.message(ids.sat)!.parts, undefined);
  });

  it('reads former group names, rename titles, First L. titles and the sender address', () => {
    assert.deepEqual(store.chat('any;+;chat900')!.formerTitles, ['Cabin Trip']);
    assert.equal(store.chatActivity('any;+;chat900').groupEvents.at(-1)!.system?.title, 'Lake House');
    assert.equal(store.chatTitle(store.chat('any;+;chat901')!), 'Sam O., Sam L.');
    assert.equal(store.message(ids.sat)!.senderAddress, '+15555550142');
    assert.equal(store.message(ids.oldMine)!.senderAddress, undefined);
  });

  it('matches link words in the preview title or attributedBody URL, and link domains', () => {
    const links = (f: { linkQuery?: string; linkDomain?: string }) =>
      store
        .listMessages({ hasLink: true, ...f }, { order: 'desc', limit: 10, offset: 0 })
        .items.map((m) => m.messageId);
    assert.deepEqual(links({ linkQuery: 'lakeside' }), [ids.link]);
    assert.deepEqual(links({ linkQuery: '48213 rooms' }), [ids.link]);
    assert.deepEqual(links({ linkQuery: 'lakeside nope' }), []);
    assert.deepEqual(links({ linkDomain: 'stays.example' }), [ids.link]);
    assert.deepEqual(links({ linkDomain: 'tays.example' }), []);
    assert.deepEqual(
      store
        .search({ text: 'lakeside', linkDomain: 'www.stays.example' }, { sort: 'newest', limit: 5, offset: 0 })
        .items.map((m) => m.messageId),
      [ids.link],
    );
    assert.equal(store.listAttachments({ nameQuery: 'jpg img_1' }, { limit: 10, offset: 0 }).total, 1);
    assert.equal(store.listAttachments({ nameQuery: 'img_%' }, { limit: 10, offset: 0 }).total, 0);
  });

  it('indexes text with codes removed, rebuilds under a new version, and supports match=any', () => {
    assert.equal(store.side.get('fts_version'), '3r');
    assert.equal(store.search({ text: '482913' }, { sort: 'newest', limit: 5, offset: 0 }).total, 0);
    assert.equal(store.search({ text: 'verification code' }, { sort: 'newest', limit: 5, offset: 0 }).total, 1);
    assert.equal(store.search({ text: 'cabins grills' }, { sort: 'relevance', limit: 5, offset: 0 }).total, 0);
    assert.equal(
      store.search({ text: 'cabins grills' }, { sort: 'relevance', limit: 5, offset: 0, match: 'any' }).total,
      2,
    );
  });

  it('acknowledges a chat whose last message the owner tapbacked', () => {
    assert.equal(store.summarizeChat('any;-;+15555550177').needsReply, false);
    assert.equal(store.summarizeChat('any;-;+15555550142').needsReply, true);
  });

  it('reports 1:1, group and last-message figures for a person', () => {
    const a = store.personActivity(samO());
    assert.equal(a.dmMessageCount! + a.sentByThemInGroups!, a.messageCount);
    assert.equal(a.sentByThemInGroups, 1);
    assert.equal(a.lastFromMe?.messageId, ids.sms);
    assert.equal(a.lastFromThem?.messageId, ids.call);
    assert.equal(store.personActivity(jo()).lastFromMe, undefined);
  });

  it('keeps an explicit from in stats', () => {
    const rows = store.stats('chat', 'sent', { from: { kind: 'person', personId: jo() } });
    assert.deepEqual(
      rows.map((r) => [r.label, r.value]),
      [['Lake House', 1]],
    );
  });

  it('migrates an older sidecar and round-trips draft fields', () => {
    assert.deepEqual(store.drafts().find((d) => d.draftId === 'dold')!.attempts, 0);
    const d = store.createDraft({
      chatId: 'any;-;+15555550142',
      text: 'files',
      attachmentNames: [],
      replyTo: ids.sat,
      effect: 'confetti',
      confirmed: true,
      attachments: [{ filename: 'IMG_1.JPG', mime: 'image/jpeg', sourceAttachmentId: 'a1' }],
    });
    const back = store.drafts().find((x) => x.draftId === d.draftId)!;
    assert.deepEqual(
      [back.replyTo, back.effect, back.confirmed, back.attempts, back.attachmentNames, back.attachments],
      [
        ids.sat,
        'confetti',
        true,
        0,
        ['IMG_1.JPG'],
        [{ filename: 'IMG_1.JPG', mime: 'image/jpeg', sourceAttachmentId: 'a1' }],
      ],
    );
    assert.equal(store.markDraftFailed(d.draftId, 'send_disabled').status, 'failed');
    assert.equal(store.drafts().find((x) => x.draftId === d.draftId)!.error, 'send_disabled');
    const reset = store.updateDraft(d.draftId, { note: 'later', confirmed: false });
    const again = store.drafts().find((x) => x.draftId === d.draftId)!;
    assert.deepEqual(
      [reset.status, again.status, again.error, again.note, again.confirmed],
      ['draft', 'draft', undefined, 'later', undefined],
    );
  });

  it('sends drafts with their extras and the attempt counter in the key; refuses empty drafts', async () => {
    const calls: { key: string; files: number; extras?: object }[] = [];
    let fail = true;
    sendImpl = async (target, _text, files, _svc, key, extras) => {
      calls.push({ key, files: files.length, extras });
      return fail
        ? {
            disposition: 'failed',
            chatId: target.chatId!,
            error: { code: 'not_delivered', message: 'x' },
            retrySafe: true,
          }
        : { disposition: 'delivered', chatId: target.chatId!, message: store.message(ids.oldMine), retrySafe: false };
    };
    const d = store.createDraft({
      chatId: 'any;-;+15555550142',
      text: 'hello',
      attachmentNames: [],
      effect: 'confetti',
      attachments: [{ filename: 'IMG_1.JPG', mime: 'image/jpeg', sourceAttachmentId: 'a1' }],
    });
    await store.sendDraft(d.draftId);
    fail = false;
    await store.sendDraft(d.draftId);
    assert.deepEqual(
      calls.map((c) => c.key),
      [`draft:${d.draftId}:0`, `draft:${d.draftId}:1`],
    );
    assert.deepEqual([calls[0].files, calls[0].extras], [1, { effect: 'confetti' }]);
    const sent = store.drafts().find((x) => x.draftId === d.draftId)!;
    assert.deepEqual([sent.status, sent.attempts, sent.sentMessageId], ['sent', 1, ids.oldMine]);
    await assert.rejects(
      store.sendDraft(d.draftId),
      (e: unknown) => e instanceof ToolError && e.code === 'already_sent' && e.message.includes(ids.oldMine),
    );
    sendImpl = async () => {
      throw new ToolError('in_progress', 'busy');
    };
    const p = store.createDraft({
      chatId: 'any;-;+15555550142',
      text: 'x',
      attachmentNames: [],
      sendAt: Date.now() + 60_000,
    });
    await assert.rejects(store.sendDraft(p.draftId), code('in_progress'));
    assert.deepEqual(
      [
        store.drafts().find((x) => x.draftId === p.draftId)!.status,
        store.drafts().find((x) => x.draftId === p.draftId)!.attempts,
      ],
      ['scheduled', 0],
    );
    const blank = store.createDraft({ chatId: 'any;-;+15555550142', text: ' ', attachmentNames: [] });
    assert.equal((await store.sendDraft(blank.draftId)).error?.code, 'empty_message');
    assert.equal(store.drafts().find((x) => x.draftId === blank.draftId)!.status, 'failed');
  });

  it('dismisses reminders by dismiss_when using the existing column', async () => {
    store.setReminder('any;-;+15555550177', Date.now() + 3_600_000, 'reply', 'i_reply');
    store.setReminder('any;+;chat900', Date.now() + 3_600_000, undefined, true);
    store.setReminder('any;+;chat901', Date.now() + 3_600_000, undefined, 'never');
    assert.deepEqual(
      store
        .reminders()
        .map((r) => r.dismissWhen)
        .sort(),
      ['i_reply', 'never', 'they_reply'],
    );
    const later = Date.now() + 2000;
    write((db) => {
      insert(db, 2, 2, false, later, 'hello again');
      insert(db, 3, 0, true, later, 'my own message');
      insert(db, 4, 1, false, later, 'theirs');
    });
    assert.equal(store.reminders().length, 3);
    let answer = '';
    write((db) => {
      answer = insert(db, 2, 0, true, later + 1000, 'answering now').id;
      insert(db, 3, 1, false, later + 1000, 'their reply');
    });
    assert.deepEqual(
      store.reminders().map((r) => r.chatId),
      ['any;+;chat901'],
    );
    // the cleared ones are kept a week with the message that cleared them
    const gone = store.dismissedReminders();
    assert.deepEqual(gone.map((d) => [d.chatId, d.dismissWhen]).sort(), [
      ['any;+;chat900', 'they_reply'],
      ['any;-;+15555550177', 'i_reply'],
    ]);
    const mine = gone.find((d) => d.chatId === 'any;-;+15555550177')!;
    assert.equal(mine.dismissedBy, answer);
    assert.equal(mine.note, 'reply');
    assert.ok(Math.abs(mine.dismissedAt - (later + 1000)) < 1000);
    // a new reminder on the chat drops its old record ('never' here: the fixture's messages are dated a few seconds
    // ahead)
    store.setReminder('any;-;+15555550177', Date.now() + 3_600_000, 'again', 'never');
    assert.deepEqual(
      store.dismissedReminders().map((d) => d.chatId),
      ['any;+;chat900'],
    );
    store.setReminder('any;-;+15555550177', null, undefined, 'never');
  });

  it('puts the actor, reaction and previous text on update events', () => {
    assert.match(store.bootId, /^[0-9a-f]{8}$/);
    store.poll();
    const start = store.latestSeq();
    write((db) => {
      insert(db, 1, 1, false, Date.now(), null, { assocGuid: `p:0/G-${ids.oldMine.slice(1)}`, assocType: 2001 });
      insert(db, 2, 2, false, Date.now(), 'new from Sam Lee');
      db.prepare(
        'update message set attributedBody = ?, date_edited = ?, message_summary_info = ? where ROWID = ?',
      ).run(body('see you at 8'), appleNs(Date.now()), PLIST.edit7to8, Number(ids.oldMine.slice(1)));
    });
    store.poll();
    const ev = store.updatesSince(start);
    const reaction = ev.find((e) => e.type === 'reaction')!;
    assert.deepEqual(
      [reaction.messageId, reaction.actorId, reaction.reaction],
      [ids.oldMine, samO(), { kind: 'like', removed: false }],
    );
    assert.equal(ev.find((e) => e.type === 'new')!.actorId, samL());
    const edited = ev.find((e) => e.type === 'edited')!;
    assert.deepEqual([edited.actorId, edited.previousText], [ME, 'see you at 7']);
    assert.ok(store.oldestSeq() <= start + 1);
  });

  it('caps served files at MAX_FILE_BYTES and reports a missing extractor as unavailable', async () => {
    const f = await store.attachmentFile('a1');
    assert.equal(f?.data.toString(), 'jpeg');
    truncateSync(join(dir, 'IMG_1.JPG'), MAX_FILE_BYTES + 1);
    assert.equal(await store.attachmentFile('a1'), null);
    (store as unknown as { files: { extractor: Promise<string | null> } }).files.extractor = Promise.resolve(null);
    await assert.rejects(
      store.attachmentText('a1'),
      (e: unknown) => e instanceof ToolError && e.code === 'unavailable' && /xcode-select --install/.test(e.fix!),
    );
  });

  describe('private API guards (fake helper)', () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let next: (() => never) | null = null;
    const status: ImsgStatus = {
      bridgeReady: true,
      methods: [
        'tapback',
        'message.edit',
        'message.unsend',
        'read',
        'chats.markUnread',
        'typing',
        'group.addParticipant',
        'group.removeParticipant',
      ],
    };
    const fake: PrivateApi = {
      status: async () => status,
      call: async (method, params) => {
        calls.push({ method, params });
        if (next) {
          const n = next;
          next = null;
          n();
        }
        return {} as any;
      },
    };

    it('uses the shared Private-API-off wording and names the tool in errors', async () => {
      await assert.rejects(
        new LiveStore(fixtureBridgeConfig(dir)).setTyping('any;-;+15555550142', true),
        (e: unknown) =>
          e instanceof ToolError && e.code === 'requires_private_api' && /Private API tier/.test(e.message),
      );
      helper = fake;
      await assert.rejects(
        store.manageGroup('rename', { chatId: 'any;+;chat900', title: 'X' }),
        (e: unknown) =>
          e instanceof ToolError &&
          e.code === 'not_supported' &&
          e.message === "manage_group rename isn't available on this Mac." &&
          e.fix === 'Tell the user. Other actions still work.',
      );
      next = () => {
        throw new ImsgError(-32602, 'bad typing value');
      };
      await assert.rejects(
        store.setTyping('any;-;+15555550142', true),
        (e: unknown) =>
          e instanceof ToolError &&
          e.code === 'rejected' &&
          e.message === 'set_typing was not run: bad typing value' &&
          /Nothing happened/.test(e.fix!),
      );
      next = () => {
        throw new TypeError('socket closed');
      };
      await assert.rejects(
        store.setTyping('any;-;+15555550142', true),
        (e: unknown) => e instanceof ToolError && e.code === 'outcome_unknown' && /Do not retry blindly/.test(e.fix!),
      );
      next = () => {
        throw new ImsgError(-32000, 'odd failure', undefined, false);
      };
      await assert.rejects(
        store.setTyping('any;-;+15555550142', true),
        (e: unknown) =>
          e instanceof ToolError && e.code === 'private_api_error' && /may have gone through/.test(e.fix!),
      );
      next = () => {
        throw new ImsgError(-32004, 'busy');
      };
      await assert.rejects(
        store.setTyping('any;-;+15555550142', true),
        (e: unknown) => e instanceof ToolError && e.code === 'busy' && /not run/.test(e.fix!),
      );
    });

    it('refuses unsent, undelivered, SMS, foreign and old messages through the tools before calling the helper', async () => {
      const { call } = await connectTools(makeCtx({}, { store }));
      const n = calls.length;
      const refused = async (tool: string, args: Record<string, unknown>, want: string) => {
        const r = await call(tool, args);
        assert.equal(errCode(r), want, `${tool} ${JSON.stringify(args)}`);
        assert.match(text(r), /\nFix: /);
      };
      await refused('edit_message', { message_id: ids.unsent, text: 'x' }, 'unsent');
      await refused('edit_message', { message_id: ids.failed, text: 'x' }, 'not_delivered');
      await refused('unsend_message', { message_id: ids.sms }, 'not_imessage');
      await refused('edit_message', { message_id: ids.sat, text: 'x' }, 'not_yours');
      await refused('edit_message', { message_id: ids.photos, text: 'x' }, 'edit_window_passed');
      await refused('manage_group', { action: 'rename', chat: 'any;+;chat900' }, 'title_required');
      assert.equal(calls.length, n);
    });

    it('checks group membership before calling the helper', async () => {
      const n = calls.length;
      await assert.rejects(
        store.manageGroup('remove', { chatId: 'any;+;chat901', personId: jo() }),
        code('not_a_member'),
      );
      await assert.rejects(
        store.manageGroup('remove', { chatId: 'any;+;chat901', address: '+15555559999' }),
        code('not_a_member'),
      );
      assert.equal(
        (await store.manageGroup('add', { chatId: 'any;+;chat901', personId: samL() })).chatId,
        'any;+;chat901',
      );
      assert.equal(calls.length, n);
    });

    it('reports mark-unread as a change only when the latest incoming message was read', async () => {
      assert.equal(await store.markRead('any;-;+15555550177', true), 1);
      write((db) => {
        db.prepare('update message set is_read = 0 where ROWID = ?').run(Number(ids.call.slice(1)));
      });
      assert.equal(await store.markRead('any;-;+15555550142', true), 0);
      assert.equal(await store.markRead('any;-;+15555550142', false), 1);
    });

    it('settles a tapback removal on the same part', async () => {
      const fold: PrivateApi = {
        status: async () => status,
        call: async (method, params) => {
          calls.push({ method, params });
          write((db) =>
            insert(db, 1, 0, true, Date.now(), null, {
              assocGuid: `p:${params.part_index}/${params.message_guid}`,
              assocType:
                (params.remove ? 3000 : 2000) +
                ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'].indexOf(String(params.reaction)),
            }),
          );
          return {} as any;
        },
      };
      helper = fold;
      const added = await store.react(ids.photos, 'like', undefined, false, 2);
      assert.ok(added.reactions.some((r) => r.by === ME && r.kind === 'like' && r.part === 2));
      const removed = await store.react(ids.photos, 'like', undefined, true, 2);
      assert.ok(!removed.reactions.some((r) => r.by === ME && (r.part ?? 0) === 2));
      assert.deepEqual(calls.at(-1)!.params, {
        chat_guid: 'any;-;+15555550142',
        message_guid: `G-${ids.photos.slice(1)}`,
        reaction: 'like',
        remove: true,
        part_index: 2,
      });
    });
  });
});
