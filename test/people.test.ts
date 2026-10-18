import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_SCOPES, SCOPES } from '../src/auth/scopes.js';
import { loadToolConfig } from '../src/config.js';
import { dmChatsFor } from '../src/lib/resolve.js';
import { fmtIso, localParts } from '../src/lib/time.js';
import { CODE_MARKER } from '../src/policy/redact.js';
import { GATED_TOOLS } from '../src/policy/sendPolicy.js';
import { buildServer } from '../src/server.js';
import type { Ctx } from '../src/tools/context.js';
import { type Result, text } from './helpers/mcp.js';
import { newMockStore, PINNED_NOW } from './helpers/mock.js';

const TZ = 'America/New_York';
const PA_TOOLS = ['react', 'edit_message', 'unsend_message', 'mark_read', 'set_typing', 'manage_group'];

async function setup(env: Record<string, string> = {}, scopes: string[] = ALL_SCOPES) {
  const cfg = loadToolConfig(env as NodeJS.ProcessEnv, {
    timeZone: TZ,
    linkSecret: 'people-test-link-secret-0123456789',
    tiers: 'read,send,org,pa,gpt',
  });
  const ctx: Ctx = {
    store: newMockStore(),
    cfg,
    baseUrl: 'https://imessage.example',
    sendLog: [],
    scopes: new Set(scopes),
    resourceMetadataUrl: 'https://imessage.example/.well-known/oauth-protected-resource/mcp',
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx).connect(a);
  const c = new Client({ name: 'people-test', version: '1' });
  await c.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await c.callTool({ name, arguments: { intent: 'unit test of the people tools', ...args } })) as Result;
  const sc = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    assert.notEqual(r.isError, true, text(r));
    return r.structuredContent;
  };
  return { ctx, call, sc };
}

const monthKey = (iso: string) => {
  const p = localParts(Date.parse(iso), TZ);
  return `${p.y}-${String(p.mo).padStart(2, '0')}`;
};
const nextMonth = (k: string) => {
  const [y, m] = k.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

describe('get_status', () => {
  it('reports the current time, scopes, the kill switch, privacy and a full tier set', async () => {
    const { sc } = await setup();
    const s = await sc('get_status');
    assert.ok(Math.abs(Date.parse(s.now) - PINNED_NOW) < 60_000, s.now);
    assert.equal(s.now_local, 'Sat Oct 17 2026 16:47 EDT');
    assert.equal(s.time_zone, TZ);
    assert.deepEqual(s.granted_scopes, [...ALL_SCOPES].sort());
    assert.equal(s.send_policy.send_enabled, true);
    assert.deepEqual(s.send_policy.gated_tools, GATED_TOOLS);
    assert.ok(!s.send_policy.gated_tools.some((t: string) => t.startsWith('unsend_message')));
    assert.equal(s.send_policy.redact_verification_codes, true);
    assert.equal(s.redact_verification_codes, true);
    assert.deepEqual(s.privacy, { verification_codes: 'hidden', marker: CODE_MARKER });
    assert.ok(s.mock_notes.some((n: string) => n.includes(CODE_MARKER)));
    assert.equal(s.private_api, 'on');
    assert.equal(s.unavailable, undefined);
    assert.deepEqual(s.health, { mode: 'mock', private_api: 'ready' });
    assert.ok(s.tiers.includes('pa'));
  });

  it('explains a missing Private API tier, sending off, codes shown and a read-only grant', async () => {
    const { sc } = await setup({ TIERS: 'read,send,org,gpt', SEND_ENABLED: 'false', REDACT_CODES: 'false' }, [
      SCOPES.read,
    ]);
    const s = await sc('get_status');
    assert.deepEqual(s.granted_scopes, ['messages.read']);
    assert.equal(s.send_policy.send_enabled, false);
    assert.match(s.private_api, /^off: reactions, edits, unsends/);
    assert.match(s.private_api, /PRIVATE_API=imsg/);
    assert.equal(s.health.private_api, 'off');
    assert.equal(s.unavailable.length, 1);
    const pa = s.unavailable[0];
    assert.equal(pa.tier, 'pa');
    assert.deepEqual([...pa.tools].sort(), [...PA_TOOLS].sort());
    assert.deepEqual(pa.send_message_params, ['reply_to', 'effect']);
    assert.match(pa.fix, /PRIVATE_API=imsg/);
    assert.deepEqual(s.privacy, { verification_codes: 'shown', marker: CODE_MARKER });
    assert.equal(s.redact_verification_codes, false);
    assert.ok(!s.mock_notes.some((n: string) => n.includes(CODE_MARKER)));
    assert.ok(s.mock_notes.some((n: string) => /codes are shown/.test(n)));
  });

  it('lists every disabled tier with its tools when only read is on', async () => {
    const { sc } = await setup({ TIERS: 'read' });
    const s = await sc('get_status');
    const byTier = new Map<string, any>(s.unavailable.map((u: any) => [u.tier, u]));
    assert.deepEqual([...byTier.keys()].sort(), ['gpt', 'org', 'pa', 'send']);
    assert.ok(byTier.get('send').tools.includes('send_message'));
    assert.match(byTier.get('send').fix, /TIERS/);
    assert.equal(byTier.get('pa').send_message_params, undefined);
    assert.ok(byTier.get('org').tools.includes('set_reminder'));
  });
});

describe('get_person', () => {
  it('shows your last 1:1 message, who spoke last per chat and whether they wait on you', async () => {
    const { sc } = await setup();
    const p = await sc('get_person', { person: 'Sam Lee' });
    assert.equal(p.person_id, 'p_sam_lee');
    assert.equal(p.last_from_you.snippet, 'hey! same, see you Thursday');
    assert.equal(p.last_from_you.chat_id, 'iMessage;-;+15555550177');
    assert.equal(p.needs_reply, true);
    assert.deepEqual(Object.keys(p.dm_chats[0]).slice(-4), [
      'last_activity',
      'last_from',
      'needs_reply',
      'unread_count',
    ]);
    assert.equal(p.dm_chats[0].last_from, 'Sam Lee');
    assert.equal(p.dm_chats[0].needs_reply, true);
    assert.equal(p.dm_chats[0].unread_count, 1);
    assert.equal(p.groups.length, 1);
    assert.equal(p.groups[0].members, 4);
    assert.ok(
      typeof p.groups[0].last_from === 'string' && 'needs_reply' in p.groups[0] && 'unread_count' in p.groups[0],
    );
    assert.equal(p.stats.in_dms, 4);
    assert.equal(p.stats.sent_by_them_in_groups, 4);
    assert.equal(
      p.stats.active_days_in_dms,
      p.stats.days_each_started_the_conversation.you + p.stats.days_each_started_the_conversation.them,
    );
    assert.match(p.more, /search_messages\(from="p_sam_lee"\)/);
  });

  it('starts by_month_last_12 at the first message, never with leading zero months', async () => {
    const { sc } = await setup();
    const sam = await sc('get_person', { person: 'Sam Lee' });
    const keys = Object.keys(sam.stats.by_month_last_12);
    assert.equal(keys[0], monthKey(sam.stats.first_message_at));
    assert.equal(keys[keys.length - 1], '2026-10', 'ends at the current month');
    for (let i = 1; i < keys.length; i++) assert.equal(keys[i], nextMonth(keys[i - 1]));
    const mom = await sc('get_person', { person: 'Mom' });
    assert.equal(Object.keys(mom.stats.by_month_last_12).length, 12);
  });

  it('marks a chat where you spoke last as not needing a reply', async () => {
    const { sc } = await setup();
    const dad = await sc('get_person', { person: 'Dad', include_groups: false });
    assert.equal(dad.groups, undefined);
    assert.equal(dad.needs_reply, false);
    assert.equal(dad.dm_chats[0].last_from, 'me');
    assert.equal(dad.last_from_you.at, dad.last_interaction.at);
  });

  it('hides a verification code in your own last message too', async () => {
    const { ctx, sc } = await setup();
    await ctx.store.send(
      { chatId: 'iMessage;-;+15555550133' },
      'the door code is 4821, see you at 7',
      [],
      'auto',
      'people-test-key-0001',
    );
    const jo = await sc('get_person', { person: 'Jo Kim' });
    assert.match(jo.last_from_you.snippet, /\[verification code hidden\]/);
    assert.doesNotMatch(jo.last_from_you.snippet, /4821/);
  });
});

describe('get_stats', () => {
  it('keeps total the same for every group_by and sets your group messages aside in rankings', async () => {
    const { ctx, sc } = await setup();
    const totals = [];
    for (const g of ['person', 'chat', 'month', 'weekday', 'hour'])
      totals.push((await sc('get_stats', { group_by: g })).total);
    assert.deepEqual(new Set(totals).size, 1, String(totals));
    assert.equal(totals[0], ctx.store.counts().messages);
    const st = await sc('get_stats', { group_by: 'person' });
    assert.ok(!st.rows.some((r: any) => r.key === 'me'));
    assert.ok(st.your_group_messages > 0);
    assert.equal(st.rows[0].label, 'Linda Carter');
    assert.deepEqual(st.rows[0].aka, ['Mom']);
    for (const g of ['person', 'chat', 'month'])
      assert.equal((await sc('get_stats', { group_by: g, chat: 'Cabin Weekend' })).total, 12);
  });

  it('shows a "You" row when the scope is a group, so "how many did I send there" is right', async () => {
    const { sc } = await setup();
    const cabin = await sc('get_stats', { group_by: 'person', chat: 'Cabin Weekend' });
    assert.ok(cabin.rows.some((r: any) => r.key === 'me' && r.label === 'You'));
    assert.equal(
      cabin.rows.reduce((n: number, r: any) => n + r.value, 0),
      cabin.total,
    );
    assert.equal(cabin.your_group_messages, undefined);
    const sent = await sc('get_stats', { group_by: 'person', chat: 'Cabin Weekend', metric: 'sent' });
    assert.equal(sent.total, 1);
    assert.equal(sent.rows[0].key, 'me');
    assert.ok(
      (await sc('get_stats', { group_by: 'person', chat_type: 'group' })).rows.some((r: any) => r.key === 'me'),
    );
  });

  it('counts what one person sent with from, and refuses from that contradicts metric', async () => {
    const { ctx, sc, call } = await setup();
    const st = await sc('get_stats', { group_by: 'month', from: 'Sam Lee' });
    assert.equal(
      st.total,
      ctx.store.listMessages({ from: { kind: 'person', personId: 'p_sam_lee' } }, { order: 'asc', limit: 1, offset: 0 })
        .total,
    );
    assert.equal(st.scope, 'all conversations, messages from Sam Lee');
    const a = await call('get_stats', { group_by: 'person', from: 'Sam Lee', metric: 'sent' });
    assert.equal(a.isError, true);
    assert.match(text(a), /^Error conflicting_filters: .*\nFix: Drop from/);
    const b = await call('get_stats', { group_by: 'person', from: 'me', metric: 'received' });
    assert.match(text(b), /^Error conflicting_filters: .*\nFix: Drop from, or use metric=sent\./);
  });

  it('applies on, and echoes the range it counted', async () => {
    const { ctx, sc } = await setup();
    const all = await sc('get_stats', { group_by: 'month' });
    const month = all.rows.find((r: any) => r.value > 0 && !r.partial);
    const on = await sc('get_stats', { group_by: 'person', on: month.key });
    assert.equal(on.total, month.value);
    assert.notEqual(on.total, all.total);
    assert.equal(monthKey(on.range.from), month.key);
    const first = ctx.store.listMessages({}, { order: 'asc', limit: 1, offset: 0 }).items[0];
    assert.equal(all.range.from, fmtIso(first.sentAt, TZ));
    assert.equal(all.rows[0].key, monthKey(all.range.from));
    assert.equal(all.rows[all.rows.length - 1].key, monthKey(all.range.to));
    assert.ok(Math.abs(Date.parse(all.range.to) - ctx.store.now()) < 5000);
  });

  it('fills empty months, hours and weekdays and flags partial months', async () => {
    const { sc } = await setup();
    const st = await sc('get_stats', { group_by: 'month', person: 'Sam Ortiz', after: '1y' });
    assert.equal(st.rows.length, 13);
    for (let i = 1; i < st.rows.length; i++) assert.equal(st.rows[i].key, nextMonth(st.rows[i - 1].key));
    assert.ok(st.rows.some((r: any) => r.value === 0));
    assert.equal(st.rows[0].partial, true);
    assert.equal(st.rows[12].partial, true);
    assert.ok(st.rows.slice(1, 12).every((r: any) => r.partial === undefined));
    assert.equal(
      st.rows.reduce((n: number, r: any) => n + r.value, 0),
      st.total,
    );
    const hours = await sc('get_stats', { group_by: 'hour', person: 'Sam Ortiz' });
    assert.deepEqual(
      hours.rows.map((r: any) => r.key),
      Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')),
    );
    assert.equal((await sc('get_stats', { group_by: 'weekday', person: 'Sam Ortiz' })).rows.length, 7);
  });

  it('filters rankings by senders and marks strangers', async () => {
    const { sc, call } = await setup();
    const all = await sc('get_stats', { group_by: 'person', top: 50 });
    const known = await sc('get_stats', { group_by: 'person', senders: 'known', top: 50 });
    const unknown = await sc('get_stats', { group_by: 'person', senders: 'unknown', top: 50 });
    assert.ok(all.rows.some((r: any) => r.key === 'p_28734' && r.in_contacts === false));
    assert.ok(!known.rows.some((r: any) => r.key === 'p_28734' || r.in_contacts === false));
    assert.ok(unknown.rows.length > 0 && unknown.rows.every((r: any) => r.in_contacts === false));
    assert.equal(known.total + unknown.total, all.total);
    assert.match(known.scope, /Contacts only$/);
    const dmKnown = await sc('get_stats', { group_by: 'chat', chat_type: 'dm', senders: 'known', top: 50 });
    assert.ok(!dmKnown.rows.some((r: any) => r.key === 'SMS;-;28734'));
    const bad = await call('get_stats', { group_by: 'hour', senders: 'known' });
    assert.match(text(bad), /^Error unsupported_filter: senders applies only to group_by=person or chat/);
  });

  it('labels chat rows with type and service, and tells same-name threads apart', async () => {
    const { ctx, sc } = await setup();
    const st = await sc('get_stats', { group_by: 'chat', top: 50 });
    assert.ok(st.rows.every((r: any) => (r.type === 'dm' || r.type === 'group') && typeof r.service === 'string'));
    const sam = st.rows.filter((r: any) => r.label === 'Sam Ortiz');
    assert.equal(sam.length, 3);
    assert.equal(new Set(sam.map((r: any) => `${r.service} ${r.via}`)).size, 3);
    assert.ok(!st.rows.some((r: any) => r.label === 'Jo Kim' && r.via));
    const mom = st.rows.find((r: any) => r.label === 'Linda Carter');
    assert.deepEqual(mom.aka, ['Mom']);
    const scoped = await sc('get_stats', { group_by: 'chat', chat: 'Sam Ortiz' });
    assert.deepEqual(
      scoped.rows.map((r: any) => r.key).sort(),
      dmChatsFor(ctx.store, 'p_sam_ortiz')
        .map((c) => c.chatId)
        .sort(),
    );
    assert.equal(scoped.scope, 'your 3 1:1 threads with Sam Ortiz, all senders');
  });

  it('says what person means in scope, and ignores unknown parameters with a note', async () => {
    const { call, sc } = await setup();
    assert.equal(
      (await sc('get_stats', { group_by: 'person', person: 'Mom' })).scope,
      '1:1 + 1 group that Linda Carter is in, all senders',
    );
    const r = await call('get_stats', { group_by: 'people', format: 'json' });
    assert.notEqual(r.isError, true);
    assert.equal(r.structuredContent.group_by, 'person');
    assert.match(r.content[r.content.length - 1].text!, /^Ignored unknown parameters: format/);
  });
});
