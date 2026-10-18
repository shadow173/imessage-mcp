// One behavior suite for every MessageStore: the rules both stores share (the update feed, the organizer, needs-reply
// and names) must hold the same way in memory and on a fixture chat.db. contract.test.ts runs it against each store.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ToolError } from '../src/lib/errors.js';
import type { MessageStore } from '../src/store/ports.js';
import { ME } from '../src/store/types.js';

export interface StoreHarness {
  store: MessageStore;
  /** A 1:1 chat with a person in Contacts. */
  dm: { chatId: string; personId: string; name: string };
  /** A message from that person arrives; returns its message_id. */
  inbound(text: string): Promise<string>;
  /** The owner sends a message in that chat; returns its message_id. */
  outbound(text: string): Promise<string>;
  /** The owner tapbacks a message. */
  tapback(messageId: string): Promise<void>;
  /** What personName() says for an id with no person: the one place the stores deliberately differ. */
  unknownName: string;
  close(): void;
}

const code = (c: string) => (e: unknown) => e instanceof ToolError && e.code === c;
const HOUR = 3_600_000;

export function storeContract(name: string, make: () => Promise<StoreHarness>): void {
  describe(`MessageStore contract: ${name}`, () => {
    let h: StoreHarness | undefined;
    const open = async () => {
      h = await make();
      return h;
    };
    afterEach(() => {
      h?.close();
      h = undefined;
    });

    it('numbers update events, holds them, and wakes a waiting get_updates', async () => {
      const { store, dm, inbound } = await open();
      const start = store.latestSeq();
      assert.equal(store.oldestSeq(), start + 1);
      const waiting = store.waitForUpdate(start, 5000);
      const id = await inbound('are you around?');
      await waiting;
      const events = store.updatesSince(start);
      assert.ok(store.latestSeq() > start);
      assert.ok(store.oldestSeq() <= start + 1);
      const ev = events.find((e) => e.messageId === id)!;
      assert.deepEqual([ev.type, ev.chatId, ev.actorId], ['new', dm.chatId, dm.personId]);
      assert.deepEqual(store.updatesSince(store.latestSeq()), []);
      await store.waitForUpdate(store.latestSeq() - 1, 5000);
      const t0 = Date.now();
      await store.waitForUpdate(store.latestSeq(), 60);
      assert.ok(Date.now() - t0 >= 50);
    });

    it('merges aliases case-insensitively, normalizes labels, and removes either', async () => {
      const { store, dm } = await open();
      const before = store.person(dm.personId)!.aliases.length;
      const p = store.updatePerson(dm.personId, {
        addAliases: ['Landlord', ' landlord ', 'Big Sam'],
        addLabels: ['#Work', 'work', ' '],
        note: 'pays on the 1st',
      });
      assert.equal(p.aliases.length, before + 2);
      assert.deepEqual(
        p.aliases.filter((a) => /landlord|big sam/i.test(a)),
        ['Landlord', 'Big Sam'],
      );
      assert.ok(p.labels.includes('work') && p.labels.every((l) => l === l.trim().toLowerCase() && l));
      assert.equal(p.note, 'pays on the 1st');
      const q = store.updatePerson(dm.personId, { removeAliases: ['LANDLORD'], removeLabels: ['#WORK'], note: '' });
      assert.ok(!q.aliases.includes('Landlord') && q.aliases.includes('Big Sam'));
      assert.ok(!q.labels.includes('work'));
      assert.equal(q.note, undefined);
      assert.deepEqual(store.person(dm.personId)!.aliases, q.aliases);
      assert.throws(() => store.updatePerson('p_nobody', { note: 'x' }), code('person_not_found'));

      const c = store.labelChat(dm.chatId, ['#Trip', 'work'], []);
      assert.ok(c.labels.includes('trip') && c.labels.includes('work'));
      assert.deepEqual(
        store.labelChat(dm.chatId, [], ['WORK']).labels.filter((l) => l === 'trip' || l === 'work'),
        ['trip'],
      );
      assert.ok(store.labelCounts().some((l) => l.name === 'trip' && l.count >= 1));
      assert.throws(() => store.labelChat('iMessage;-;+15550009999', ['x'], []), code('chat_not_found'));
    });

    it('moves drafts between draft, scheduled, failed and sent; a sent draft is final', async () => {
      const { store, dm } = await open();
      const now = store.now();
      const d = store.createDraft({ chatId: dm.chatId, text: 'see you then', attachmentNames: [] });
      assert.deepEqual([d.status, d.attempts, d.attachmentNames], ['draft', 0, []]);
      const s = store.createDraft({ chatId: dm.chatId, text: 'later', attachmentNames: [], sendAt: now + HOUR });
      assert.equal(s.status, 'scheduled');
      assert.equal(store.updateDraft(s.draftId, { sendAt: null }).status, 'draft');
      assert.equal(store.updateDraft(s.draftId, { sendAt: now - 1000 }).status, 'draft');
      assert.equal(store.updateDraft(s.draftId, { sendAt: now + HOUR }).status, 'scheduled');

      assert.equal(store.markDraftFailed(d.draftId, 'send_disabled').status, 'failed');
      const reset = store.updateDraft(d.draftId, { note: 'retry' });
      assert.deepEqual([reset.status, reset.error, reset.note], ['draft', undefined, 'retry']);

      const blank = store.createDraft({ chatId: dm.chatId, text: '  ', attachmentNames: [] });
      const r = await store.sendDraft(blank.draftId);
      assert.deepEqual([r.disposition, r.error?.code, r.retrySafe], ['failed', 'empty_message', false]);
      const failed = store.drafts().find((x) => x.draftId === blank.draftId)!;
      assert.deepEqual([failed.status, failed.error], ['failed', 'empty_message']);

      const sent = await store.sendDraft(d.draftId);
      assert.notEqual(sent.disposition, 'failed');
      const after = store.drafts().find((x) => x.draftId === d.draftId)!;
      assert.equal(after.status, 'sent');
      assert.ok(after.sentMessageId);
      assert.throws(() => store.updateDraft(d.draftId, { text: 'x' }), code('already_sent'));
      assert.throws(() => store.markDraftFailed(d.draftId, 'x'), code('already_sent'));
      await assert.rejects(store.sendDraft(d.draftId), code('already_sent'));

      store.deleteDraft(s.draftId);
      assert.ok(!store.drafts().some((x) => x.draftId === s.draftId));
      assert.throws(() => store.deleteDraft(s.draftId), code('draft_not_found'));
    });

    it('dismisses a reminder on the next message from the side it waits for, and keeps a record', async () => {
      const { store, dm, inbound, outbound } = await open();
      const r = store.setReminder(dm.chatId, store.now() + HOUR, 'ask about rent', 'they_reply')!;
      assert.deepEqual([r.dismissWhen, r.dismissOnReply, r.note], ['they_reply', true, 'ask about rent']);
      await outbound('my own message');
      assert.ok(store.reminders().some((x) => x.chatId === dm.chatId));
      const theirs = await inbound('their reply');
      assert.ok(!store.reminders().some((x) => x.chatId === dm.chatId));
      const gone = store.dismissedReminders().find((x) => x.chatId === dm.chatId);
      assert.deepEqual([gone?.reminderId, gone?.dismissedBy, gone?.dismissWhen], [r.reminderId, theirs, 'they_reply']);

      store.setReminder(dm.chatId, store.now() + HOUR, undefined, 'i_reply');
      await inbound('anything new?');
      assert.ok(store.reminders().some((x) => x.chatId === dm.chatId && x.dismissWhen === 'i_reply'));
      const mine = await outbound('on it');
      assert.ok(!store.reminders().some((x) => x.chatId === dm.chatId));
      assert.equal(store.dismissedReminders().find((x) => x.chatId === dm.chatId)?.dismissedBy, mine);

      assert.equal(store.setReminder(dm.chatId, store.now() + HOUR, undefined, true)?.dismissWhen, 'they_reply');
      assert.equal(store.setReminder(dm.chatId, store.now() + HOUR, undefined, false)?.dismissWhen, 'never');
      await inbound('still there?');
      assert.ok(store.reminders().some((x) => x.chatId === dm.chatId && x.dismissWhen === 'never'));
      assert.equal(store.setReminder(dm.chatId, null, undefined, 'never'), null);
      assert.ok(!store.reminders().some((x) => x.chatId === dm.chatId));
    });

    it('needs a reply after a recent message from them, until the owner answers or tapbacks it', async () => {
      const { store, dm, inbound, outbound, tapback } = await open();
      const ask = await inbound('dinner friday?');
      let s = store.summarizeChat(dm.chatId);
      assert.deepEqual([s.lastMessage?.messageId, s.needsReply, s.unknownSender], [ask, true, false]);
      await tapback(ask);
      assert.equal(store.summarizeChat(dm.chatId).needsReply, false);
      await inbound('and saturday?');
      assert.equal(store.summarizeChat(dm.chatId).needsReply, true);
      await outbound('friday works');
      s = store.summarizeChat(dm.chatId);
      assert.deepEqual([s.needsReply, s.lastMessage?.senderId], [false, ME]);
    });

    it('names the owner "You" and titles a 1:1 by the person', async () => {
      const { store, dm, unknownName } = await open();
      assert.equal(store.personName(ME), 'You');
      assert.equal(store.personName(dm.personId), dm.name);
      assert.equal(store.chatTitle(store.chat(dm.chatId)!), dm.name);
      assert.equal(store.summarizeChat(dm.chatId).title, dm.name);
      assert.equal(store.personName('p_nobody'), unknownName);
    });
  });
}
