import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_SCOPES } from '../src/auth/scopes.js';
import { loadToolConfig } from '../src/config.js';
import type { MockStore } from '../src/mock/mockStore.js';
import { buildServer } from '../src/server.js';
import { ME } from '../src/store/types.js';
import type { Ctx } from '../src/tools/context.js';
import { type Result, text } from './helpers/mcp.js';
import { newMockStore } from './helpers/mock.js';

const TZ = 'America/New_York';
const MOM = 'iMessage;-;+15555550111';
const JO = 'iMessage;-;+15555550133';
const CABIN = 'iMessage;+;chat58213';
const TEAM = 'iMessage;+;chat33107';
const SAM_LEE = 'iMessage;-;+15555550177';

const ctxFor = (): Ctx => ({
  store: newMockStore(),
  cfg: loadToolConfig({} as NodeJS.ProcessEnv, {
    timeZone: TZ,
    linkSecret: 'organize-test-link-secret-0123456789',
    tiers: 'read,send,org,pa,gpt',
  }),
  baseUrl: 'https://imessage.example',
  sendLog: [],
  scopes: new Set(ALL_SCOPES),
  resourceMetadataUrl: 'https://imessage.example/.well-known/oauth-protected-resource/mcp',
});
async function setup() {
  const ctx = ctxFor();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx).connect(a);
  const c = new Client({ name: 'organize-test', version: '1' });
  await c.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await c.callTool({ name, arguments: { intent: 'organize stream unit test', ...args } })) as Result;
  return { ctx, store: ctx.store as MockStore, call, client: c };
}
const ok = (r: Result) => {
  assert.notEqual(r.isError, true, text(r));
  return r.structuredContent;
};

describe('update_person', () => {
  it('returns a compact ack: what was saved plus dm_chat_id, never message text', async () => {
    const { call } = await setup();
    const r = await call('update_person', {
      person: 'Marcus Webb',
      add_aliases: ['my landlord'],
      note: 'Building manager',
      add_labels: ['Home'],
    });
    const s = ok(r);
    assert.deepEqual(s, {
      person_id: 'p_marcus',
      name: 'Marcus Webb',
      in_contacts: true,
      aliases: ['my landlord'],
      note: 'Building manager',
      labels: ['home'],
      dm_chat_id: 'SMS;-;+15555550166',
    });
    assert.doesNotMatch(text(r), /snippet|last_interaction|smoke/);
    assert.ok(!text(r).includes('\n'), 'compact JSON');

    const mom = ok(await call('update_person', { person: 'Mom', note: 'call Sundays' }));
    assert.deepEqual(mom.nicknames, ['Mom']);
    const emma = ok(await call('update_person', { person: 'Emma Carter', add_labels: ['family'] }));
    assert.equal(emma.dm_chat_id, null);
    const stranger = ok(await call('update_person', { person: '+15555550188', note: 'unknown sender' }));
    assert.equal(stranger.in_contacts, false);
  });

  it('refuses an alias that already matches someone else until the user confirms', async () => {
    const { call, store } = await setup();
    const r = await call('update_person', {
      person: 'Linda Carter',
      add_aliases: ['Sam'],
      note: 'should not be saved',
    });
    assert.equal(r.isError, true);
    assert.match(
      text(r),
      /^Error alias_conflict: "Sam" already matches Sam Ortiz and Sam Lee\. Saving it for Linda Carter would make "Sam" mean Linda Carter in every tool, including send_message\. Nothing was saved\./,
    );
    assert.match(text(r), /Fix: Ask the user whether that is what they want, then call again with user_confirmed=true/);
    assert.match(text(r), /person_id p_sam_ortiz/);
    assert.match(text(r), /person_id p_sam_lee/);
    assert.deepEqual(store.person('p_linda')!.aliases, []);
    assert.equal(store.person('p_linda')!.note, undefined);

    const yes = ok(await call('update_person', { person: 'Linda Carter', add_aliases: ['Sam'], user_confirmed: true }));
    assert.deepEqual(yes.aliases, ['Sam']);
    assert.match(yes.warning, /"Sam" also matches Sam Ortiz and Sam Lee; pass a person_id/);
  });

  it('saves aliases that match nobody else, needs confirmation for one shared with another person, and flags a nickname clash', async () => {
    const { call, store } = await setup();
    // "Sam" names Sam Ortiz too, but saving it would silently make every "Sam" mean him
    const shared = await call('update_person', { person: 'p_sam_ortiz', add_aliases: ['Sam'] });
    assert.match(
      text(shared),
      /^Error alias_conflict: "Sam" already matches Sam Lee\. Saving it for Sam Ortiz would make "Sam" mean Sam Ortiz in every tool, including send_message\./,
    );
    assert.deepEqual(store.person('p_sam_ortiz')!.aliases, []);
    const sam = ok(await call('update_person', { person: 'p_sam_ortiz', add_aliases: ['Sam'], user_confirmed: true }));
    assert.deepEqual(sam.aliases, ['Sam']);
    assert.match(sam.warning, /"Sam" also matches Sam Lee; pass a person_id when you mean them\./);
    assert.deepEqual(
      ok(await call('update_person', { person: 'p_sam_lee', add_aliases: ['climbing gym Sam'] })).aliases,
      ['climbing gym Sam'],
    );
    ok(await call('update_person', { person: 'Marcus', add_aliases: ['landlord'] }));
    assert.equal(ok(await call('get_person', { person: 'my landlord' })).person_id, 'p_marcus');
    const mom = await call('update_person', { person: 'Emma Carter', add_aliases: ['Mom'] });
    assert.equal(mom.isError, true);
    assert.match(text(mom), /"Mom" already matches Linda Carter/);
  });

  it('resolves the person strictly (write tool)', async () => {
    const { call } = await setup();
    const amb = await call('update_person', { person: 'Sam', note: 'x' });
    assert.match(
      text(amb),
      /^Error ambiguous_person: .*\nFix: Ask the user which one they mean, then pass that person_id\./,
    );
    const loose = await call('update_person', { person: 'Rob', note: 'x' });
    assert.match(text(loose), /^Error ambiguous_person: "Rob" only partly matches Robert Carter\./);
  });
});

describe('label_conversation', () => {
  it('labels several chats in one call, deduped, and keeps the single-chat shape', async () => {
    const { call } = await setup();
    const one = ok(await call('label_conversation', { chat: 'Cabin Weekend', add: ['trip'] }));
    assert.deepEqual(one, { chat_id: CABIN, title: 'Cabin Weekend 🏔️', labels: ['trip'] });
    const many = ok(
      await call('label_conversation', { chats: ['Product Team', TEAM, 'Jo Kim', CABIN], add: ['#Work'] }),
    );
    assert.deepEqual(
      many.results.map((x: any) => x.chat_id),
      [TEAM, JO, CABIN],
    );
    assert.deepEqual(many.results[2].labels, ['trip', 'work']);
    const counts = ok(await call('label_conversation'));
    assert.deepEqual(counts.labels, [
      { name: 'work', count: 3 },
      { name: 'trip', count: 1 },
    ]);
  });

  it('labels nothing when any entry is ambiguous, unknown or loose, and refuses chat with chats', async () => {
    const { call, store } = await setup();
    const amb = await call('label_conversation', { chats: ['Jo Kim', 'Sam'], add: ['x'] });
    assert.match(text(amb), /^Error ambiguous_chat: .*Nothing was labelled\./);
    assert.match(text(amb), /Ask the user which one/);
    assert.deepEqual(store.chat(JO)!.labels, []);
    const missing = await call('label_conversation', { chats: ['Jo Kim', 'Zebra Club'], add: ['x'] });
    assert.match(text(missing), /^Error chat_not_found: .*Nothing was labelled\./);
    const loose = await call('label_conversation', { chat: 'cab', add: ['x'] });
    assert.match(text(loose), /^Error ambiguous_chat: "cab" only partly matches Cabin Weekend/);
    const both = await call('label_conversation', { chat: 'Jo Kim', chats: ['Cabin Weekend'], add: ['x'] });
    assert.match(text(both), /^Error chat_required: Pass chat, or chats for several at once, not both\./);
    assert.deepEqual(store.chat(JO)!.labels, []);
    assert.deepEqual(store.chat(CABIN)!.labels, []);
  });
});

describe('set_reminder', () => {
  it('counts relative times forward and echoes local time and due_in', async () => {
    const { call, store } = await setup();
    const r = ok(await call('set_reminder', { chat: 'Jo Kim', remind_at: '30min', note: 'ask about packing' }));
    assert.equal(r.due_in, 'in 30 min');
    assert.equal(r.remind_at_local, 'Sat Oct 17 17:17 EDT');
    assert.ok(Math.abs(Date.parse(r.remind_at) - (store.now() + 30 * 60_000)) < 61_000);
    assert.equal(r.assumed, undefined);
    const y = ok(await call('set_reminder', { chat: 'Jo Kim', remind_at: '1y' }));
    assert.ok(Date.parse(y.remind_at) > store.now() + 360 * 86_400_000);
  });

  it('rejects ambiguous, past and backwards times with the current time in the Fix', async () => {
    const { call, store } = await setup();
    const m = await call('set_reminder', { chat: 'Jo Kim', remind_at: '30m' });
    assert.match(text(m), /^Error ambiguous_unit: .*\nFix: Use 30min for minutes or 6mo for months\./);
    const past = await call('set_reminder', { chat: 'Jo Kim', remind_at: '2020-01-01T09:00' });
    assert.match(text(past), /^Error remind_at_in_past: .*which has passed\.\nFix: It is now /);
    assert.match(text(await call('set_reminder', { chat: 'Jo Kim', remind_at: '3 days ago' })), /^Error invalid_time:/);
    assert.equal(store.reminders().length, 0);
  });

  it('a date alone or bare tomorrow means 09:00, and says so', async () => {
    const { call } = await setup();
    const r = ok(await call('set_reminder', { chat: 'Jo Kim', remind_at: 'tomorrow' }));
    assert.match(r.remind_at, /T09:00:00/);
    assert.match(r.remind_at_local, / 09:00 E[SD]T$/);
    assert.match(r.assumed, /^No time was given, so 09:00 E[SD]T was used\.$/);
  });

  it('defaults dismiss_when to i_reply when a reply is owed, else they_reply; explicit values win', async () => {
    const { call } = await setup();
    const mom = ok(await call('set_reminder', { chat: 'Mom', remind_at: '2h', note: 'call back' }));
    assert.equal(mom.dismiss_when, 'i_reply');
    assert.equal(mom.dismiss_on_reply, false);
    assert.equal(
      mom.dismiss_note,
      "i_reply (default: Linda Carter is waiting on your reply): the owner's next message there clears it, so set it again after any holding reply.",
    );
    const jo = ok(await call('set_reminder', { chat: 'Jo Kim', remind_at: '2h' }));
    assert.equal(jo.dismiss_when, 'they_reply');
    assert.equal(jo.dismiss_on_reply, true);
    assert.equal(
      jo.dismiss_note,
      'they_reply (default: no reply is owed): their next message clears it; pass dismiss_when=i_reply for "remind me to reply".',
    );
    const legacy = ok(await call('set_reminder', { chat: 'Sam Lee', remind_at: '2h', dismiss_on_reply: false }));
    assert.equal(legacy.dismiss_when, 'never');
    assert.equal(legacy.dismiss_note, 'never (from dismiss_on_reply=false): only clear=true removes it.');
    const both = ok(
      await call('set_reminder', { chat: 'Priya', remind_at: '2h', dismiss_on_reply: true, dismiss_when: 'i_reply' }),
    );
    assert.equal(both.dismiss_when, 'i_reply');
    assert.match(both.dismiss_note, /^i_reply \(as requested\): the owner's next message/);
    const alias = ok(await call('set_reminder', { chat: 'Marcus Webb', remind_at: '2h', dismiss_when: 'They write' }));
    assert.equal(alias.dismiss_when, 'they_reply');
  });

  it("i_reply survives their message and clears on the owner's; they_reply is the reverse", async () => {
    const { call, store } = await setup();
    ok(await call('set_reminder', { chat: 'Mom', remind_at: '2h', dismiss_when: 'i_reply' }));
    ok(await call('set_reminder', { chat: 'Jo Kim', remind_at: '2h', dismiss_when: 'they_reply' }));
    await new Promise((r) => setTimeout(r, 5)); // the mock dismisses only on messages strictly after the reminder was created
    store.receive(MOM, 'p_linda', 'are you there?');
    store.receive(JO, ME, 'packing now');
    const ids = () =>
      store
        .reminders()
        .map((r) => r.chatId)
        .sort();
    assert.deepEqual(ids(), [JO, MOM].sort());
    store.receive(MOM, ME, 'yes, calling soon');
    store.receive(JO, 'p_jo', 'great');
    assert.deepEqual(ids(), []);
  });

  it('reports what a new reminder replaced and what clear removed', async () => {
    const { call } = await setup();
    const first = ok(await call('set_reminder', { chat: 'Sam Lee', remind_at: '1d', note: 'ask about cabin deposit' }));
    const second = ok(await call('set_reminder', { chat: 'Sam Lee', remind_at: '3h', note: 'send the packing list' }));
    assert.deepEqual(second.replaced, {
      reminder_id: first.reminder_id,
      remind_at: first.remind_at,
      note: 'ask about cabin deposit',
    });
    assert.equal(first.replaced, undefined);
    const cleared = ok(await call('set_reminder', { chat: 'Sam Lee', clear: true }));
    assert.deepEqual(cleared, {
      chat_id: 'iMessage;-;+15555550177',
      title: 'Sam Lee',
      cleared: true,
      removed: { reminder_id: second.reminder_id, remind_at: second.remind_at, note: 'send the packing list' },
    });
    const again = ok(await call('set_reminder', { chat: 'Sam Lee', clear: true }));
    assert.equal(again.removed, null);
  });

  it('lists pending reminders with no arguments, and needs chat to set or clear', async () => {
    const { call } = await setup();
    assert.deepEqual(ok(await call('set_reminder')), { reminders: [] });
    ok(await call('set_reminder', { chat: 'Mom', remind_at: '2d', note: 'Thanksgiving' }));
    ok(await call('set_reminder', { chat: 'Cabin Weekend', remind_at: '3h' }));
    const list = ok(await call('set_reminder')).reminders;
    assert.deepEqual(
      list.map((r: any) => r.title),
      ['Cabin Weekend 🏔️', 'Linda Carter'],
    );
    assert.deepEqual(Object.keys(list[1]), [
      'reminder_id',
      'chat_id',
      'title',
      'remind_at',
      'remind_at_local',
      'note',
      'dismiss_when',
      'due',
    ]);
    assert.equal(list[1].due, false);
    assert.equal(list[1].note, 'Thanksgiving');
    for (const args of [{ remind_at: '2h' }, { clear: true }, { note: 'x' }]) {
      const r = await call('set_reminder', args);
      assert.match(text(r), /^Error chat_required: Pass chat to set or clear a reminder\./);
    }
    assert.match(text(await call('set_reminder', { chat: 'Mom' })), /^Error remind_at_required:/);
  });

  it('resolves the chat strictly and advertises dismiss_when as a plain enum', async () => {
    const { call, client } = await setup();
    assert.match(
      text(await call('set_reminder', { chat: 'Sam', remind_at: '2h' })),
      /^Error ambiguous_chat: .*\nFix: Ask the user which one/,
    );
    assert.match(
      text(await call('set_reminder', { chat: 'Rob', remind_at: '2h' })),
      /^Error ambiguous_chat: "Rob" only partly matches/,
    );
    const tools = (await client.listTools()).tools;
    const props = tools.find((t) => t.name === 'set_reminder')!.inputSchema.properties as any;
    assert.deepEqual(props.dismiss_when.enum, ['i_reply', 'they_reply', 'never']);
    assert.ok(!(tools.find((t) => t.name === 'set_reminder')!.inputSchema.required ?? []).includes('chat'));
    for (const t of ['update_person', 'label_conversation', 'set_reminder'])
      assert.doesNotMatch(tools.find((x) => x.name === t)!.description!, /6m\b/);
  });

  it('keeps i_reply as the default right after a holding reply, so their answer does not clear it', async () => {
    const { call, store } = await setup();
    store.receive(SAM_LEE, ME, 'Saw this, will get back to you tomorrow!');
    const r = ok(
      await call('set_reminder', { chat: 'Sam Lee', remind_at: 'tomorrow', note: 'Reply about the ticket' }),
    );
    assert.equal(r.dismiss_when, 'i_reply');
    assert.match(
      r.dismiss_note,
      /^i_reply \(default: your message minutes ago answered theirs, likely a holding reply\)/,
    );
    await new Promise((res) => setTimeout(res, 5));
    store.receive(SAM_LEE, 'p_sam_lee', 'ok perfect');
    assert.equal(store.reminders().length, 1);
    // an old message from the owner is not a holding reply: no reply owed means they_reply
    assert.equal(ok(await call('set_reminder', { chat: 'Jo Kim', remind_at: '2h' })).dismiss_when, 'they_reply');
  });

  it('lists a reminder a message cleared, with that message, in set_reminder, clear, get_conversation and catch_up', async () => {
    const { call, store } = await setup();
    ok(
      await call('set_reminder', {
        chat: 'Jo Kim',
        remind_at: '2h',
        note: 'nudge about flights',
        dismiss_when: 'they_reply',
      }),
    );
    await new Promise((res) => setTimeout(res, 5));
    const reply = store.receive(JO, 'p_jo', 'booked them!');
    const list = ok(await call('set_reminder'));
    assert.deepEqual(list.reminders, []);
    assert.equal(list.auto_dismissed[0].dismissed_by, reply.messageId);
    assert.equal(list.auto_dismissed[0].note, 'nudge about flights');
    const cleared = ok(await call('set_reminder', { chat: 'Jo Kim', clear: true }));
    assert.equal(cleared.cleared, false);
    assert.equal(cleared.had_reminder, false);
    assert.equal(cleared.auto_dismissed.dismissed_by, reply.messageId);
    const conv = ok(await call('get_conversation', { chat: 'Jo Kim', include_stats: false }));
    assert.deepEqual(conv.reminders, []);
    assert.equal(conv.auto_dismissed_reminders[0].dismissed_by_name, 'Jo Kim');
    assert.equal('chat_id' in conv.auto_dismissed_reminders[0], false);
    const t = text(await call('catch_up', { messages_per_chat: 1 }));
    assert.match(
      t,
      new RegExp(
        `Reminders auto-dismissed in the past 7 days \\(1\\)\\n  ✓ Jo Kim · nudge about flights · auto-dismissed by Jo Kim's message #${reply.messageId} .* \\(dismiss_when they_reply\\)`,
      ),
    );
    assert.equal(
      ok(await call('catch_up', { format: 'json' })).auto_dismissed_reminders[0].dismissed_by,
      reply.messageId,
    );
    // a new reminder on the chat replaces the old record
    ok(await call('set_reminder', { chat: 'Jo Kim', remind_at: '3h' }));
    assert.equal(ok(await call('set_reminder')).auto_dismissed, undefined);
  });
});
