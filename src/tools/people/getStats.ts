import * as z from 'zod/v4';
import { chatGuidIdentifier } from '../../domain/chatGuid.js';
import { prettyAddress } from '../../lib/address.js';
import { ToolError } from '../../lib/errors.js';
import { akaOf, isUnknownDm } from '../../lib/format.js';
import { dmChatsFor, resolveChatScope, resolvePerson } from '../../lib/resolve.js';
import { fmtIso, resolveRange } from '../../lib/time.js';
import { fillStatRows } from '../../store/stats.js';
import { ME, type MessageFilter, type StatRow } from '../../store/types.js';
import { parseFrom } from '../args.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult } from '../results.js';
import { zChatScopeOpt, zFrom, zOneOf, zTime } from '../schemas.js';
import { peopleKit } from './common.js';

export const getStats = defineTool({
  name: 'get_stats',
  tier: 'read',
  title: 'Message stats',
  description: [
    'Counts and rankings across message history: who you text most, the busiest chats, activity by month, weekday or hour.',
    'For patterns, not content. total counts every matching message (not just the top rows), so any group_by answers "how many". group_by=person credits each person with what they sent anywhere plus your 1:1 messages to them; your own group messages go to your_group_messages (a "You" row when the scope is a group).',
    'For "who do I text most" use chat_type=dm and senders=known.',
    'Month, weekday and hour rows include zeros; partial: true marks a month the range only partly covers. scope and range echo what was counted (range.to is exclusive).',
    'Returns JSON.',
  ].join(' '),
  inputSchema: {
    group_by: zOneOf(['person', 'chat', 'month', 'weekday', 'hour'], {
      people: 'person',
      persons: 'person',
      sender: 'person',
      contact: 'person',
      contacts: 'person',
      chats: 'chat',
      conversation: 'chat',
      conversations: 'chat',
      months: 'month',
      monthly: 'month',
      weekdays: 'weekday',
      day_of_week: 'weekday',
      hours: 'hour',
      hourly: 'hour',
      hour_of_day: 'hour',
    }).describe('person or chat: rankings (top rows). month, weekday or hour: activity over time.'),
    metric: z
      .enum(['messages', 'sent', 'received', 'attachments'])
      .default('messages')
      .describe(
        'messages = sent by anyone, you included; sent = by you; received = by others; attachments = messages with a file.',
      ),
    person: z
      .string()
      .optional()
      .describe(
        "Only chats this person is in, groups included, counting everyone's messages there (same as search_messages with). Add chat_type=dm, or use chat=<person>, for just your 1:1 threads with them; for messages they sent use from.",
      ),
    from: zFrom,
    chat: zChatScopeOpt,
    chat_type: z.enum(['dm', 'group', 'any']).default('any').describe('dm = 1:1 chats only; group = group chats only.'),
    senders: z
      .enum(['known', 'unknown', 'all'])
      .default('all')
      .describe(
        'Rankings only (group_by person or chat). known leaves out short codes and numbers not in Contacts (use it for "who do I text most"); unknown keeps only those. Groups count as known.',
      ),
    after: zTime('On or after'),
    before: zTime('Before (exclusive: before 2026-03-30 stops at the end of Mar 29)'),
    on: zTime('Only this day or month (excludes after/before)'),
    top: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Rows returned for group_by person or chat (default 10, max 50); ignored for month, weekday and hour. total always counts every matching message.',
      ),
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store, tz } = peopleKit(ctx);
    const now = store.now();
    const ranking = a.group_by === 'person' || a.group_by === 'chat';
    const range = resolveRange({ after: a.after, before: a.before, on: a.on }, tz, now);
    if (!ranking && a.senders !== 'all')
      throw new ToolError(
        'unsupported_filter',
        `senders applies only to group_by=person or chat, not ${a.group_by}.`,
        'Drop senders, or use group_by=person or chat. For one person over time, set person or from instead.',
      );
    const from = parseFrom(store, a.from);
    if (from && from.kind !== 'me' && a.metric === 'sent')
      throw new ToolError(
        'conflicting_filters',
        `metric=sent counts only your own messages, but from="${a.from}" asks for someone else's.`,
        'Drop from, or keep from and use metric=messages.',
      );
    if (from?.kind === 'me' && a.metric === 'received')
      throw new ToolError(
        'conflicting_filters',
        'metric=received counts only other people\'s messages, but from="me" asks for yours.',
        'Drop from, or use metric=sent.',
      );
    const scope = a.chat ? resolveChatScope(store, a.chat) : undefined;
    const withPerson = a.person ? resolvePerson(store, a.person) : undefined;
    const filter: MessageFilter = {
      ...range,
      chatIds: scope?.chatIds,
      withPersonId: withPerson?.personId,
      chatType: a.chat_type === 'any' ? undefined : a.chat_type,
      ...(from ? { from } : {}),
    };
    let rows = store.stats(a.group_by, a.metric, filter);

    const unknownRow = (r: StatRow) => {
      if (a.group_by === 'person') {
        if (r.key === ME) return false;
        const p = store.person(r.key);
        return !p || p.name === null;
      }
      const c = store.chat(r.key);
      return !c || isUnknownDm(store, c);
    };
    if (ranking && a.senders !== 'all') rows = rows.filter((r) => unknownRow(r) === (a.senders === 'unknown'));
    // Counted before the owner's group row is set aside and before top, so total is the same whatever group_by is.
    const total = rows.reduce((n, r) => n + r.value, 0);
    const groupScope = scope?.chat.type === 'group' || a.chat_type === 'group';
    const yourGroup = a.group_by === 'person' && !groupScope ? (rows.find((r) => r.key === ME)?.value ?? 0) : 0;
    if (yourGroup) rows = rows.filter((r) => r.key !== ME);

    const effectiveFrom =
      from ??
      (a.metric === 'sent'
        ? { kind: 'me' as const }
        : a.metric === 'received'
          ? { kind: 'others' as const }
          : undefined);
    const first =
      range.after === undefined && total > 0
        ? store.listMessages(
            {
              ...filter,
              ...(effectiveFrom ? { from: effectiveFrom } : {}),
              ...(a.metric === 'attachments' ? { hasAttachment: true } : {}),
            },
            { order: 'asc', limit: 1, offset: 0 },
          ).items[0]?.sentAt
        : undefined;
    const winFrom = range.after ?? first;
    const winTo = Math.max(winFrom ?? 0, Math.min(range.before ?? now, now));

    if (ranking) {
      rows = rows.sort((x, y) => y.value - x.value || x.label.localeCompare(y.label)).slice(0, a.top);
      const labelCount = new Map<string, number>();
      for (const r of rows) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1);
      rows = rows.map((r) => {
        const unknown = unknownRow(r) ? { in_contacts: false } : {};
        if (a.group_by === 'person') {
          if (r.key === ME) return { ...r, label: 'You' };
          const aka = akaOf(store, r.key);
          return { ...r, ...(aka.length ? { aka } : {}), ...unknown };
        }
        const c = store.chat(r.key);
        if (!c) return { ...r, ...unknown };
        const aka = c.type === 'dm' && c.participantIds[0] ? akaOf(store, c.participantIds[0]) : [];
        const via =
          c.type === 'dm' && (labelCount.get(r.label) ?? 0) > 1
            ? { via: prettyAddress(chatGuidIdentifier(c.chatId)) }
            : {};
        return { ...r, type: c.type, service: c.service, ...via, ...(aka.length ? { aka } : {}), ...unknown };
      });
    } else {
      rows = fillStatRows(rows, a.group_by, { from: winFrom ?? 0, to: winTo }, tz).sort((x, y) =>
        x.key.localeCompare(y.key, 'en', { numeric: true }),
      );
    }

    const name = (id: string) => store.personName(id);
    const personChats = (pid: string) => {
      const dmCount = a.chat_type === 'group' ? 0 : dmChatsFor(store, pid).length;
      const groups =
        a.chat_type === 'dm'
          ? 0
          : store.chats().filter((c) => c.type === 'group' && c.participantIds.includes(pid)).length;
      const parts = [
        dmCount ? (dmCount > 1 ? `${dmCount} 1:1 threads` : '1:1') : '',
        groups ? `${groups} group${groups > 1 ? 's' : ''}` : '',
      ].filter(Boolean);
      return `${parts.join(' + ') || 'no chats'} that ${name(pid)} is in`;
    };
    const where = scope
      ? (scope.personId
          ? scope.chatIds.length > 1
            ? `your ${scope.chatIds.length} 1:1 threads with ${name(scope.personId)}`
            : `your 1:1 with ${name(scope.personId)}`
          : scope.chat.type === 'group'
            ? `the group ${store.chatTitle(scope.chat)}`
            : `the 1:1 ${store.chatTitle(scope.chat)} (one thread)`) +
        (withPerson ? `, if ${name(withPerson.personId)} is in it` : '')
      : withPerson
        ? personChats(withPerson.personId)
        : a.chat_type === 'dm'
          ? 'all 1:1 chats'
          : a.chat_type === 'group'
            ? 'all group chats'
            : 'all conversations';
    const who = from
      ? from.kind === 'me'
        ? 'your messages'
        : from.kind === 'others'
          ? "other people's messages"
          : `messages from ${name(from.personId)}`
      : a.metric === 'sent'
        ? 'your messages'
        : a.metric === 'received'
          ? "other people's messages"
          : undefined;
    const senders =
      a.senders === 'known' ? 'Contacts only' : a.senders === 'unknown' ? 'unknown senders only' : undefined;
    const scopeText = [
      where,
      who ?? (senders ? undefined : 'all senders'),
      a.metric === 'attachments' ? 'with files only' : undefined,
      senders,
    ]
      .filter(Boolean)
      .join(', ');

    return jsonResult({
      group_by: a.group_by,
      metric: a.metric,
      scope: scopeText,
      total,
      ...(yourGroup ? { your_group_messages: yourGroup } : {}),
      range: { from: winFrom !== undefined ? fmtIso(winFrom, tz) : null, to: fmtIso(winTo, tz) },
      time_zone: tz,
      rows,
    });
  },
});
