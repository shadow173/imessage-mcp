import * as z from 'zod/v4';
import { chatGuidIdentifier } from '../../domain/chatGuid.js';
import { prettyAddress } from '../../lib/address.js';
import { resolvePerson } from '../../lib/resolve.js';
import { fmtIso, localParts } from '../../lib/time.js';
import { personSummary } from '../find/common.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult } from '../results.js';
import { pad, peopleKit } from './common.js';

export const getPerson = defineTool({
  name: 'get_person',
  tier: 'read',
  title: 'Get a person',
  description: [
    'Everything about one person across all their numbers and emails: their 1:1 chats and the group chats you share (each with last_from, needs_reply and unread_count), when you last talked and who spoke last (last_interaction), your own last 1:1 message (last_from_you), whether they are waiting on your reply (needs_reply), message volume by month, and any aliases and notes saved for them.',
    'One call answers "when did I last text Sam" and "what groups is Sam in".',
    'Group member counts include you; stats.total is your 1:1 messages both ways plus what they sent in groups.',
    'It shows only the latest message: for what they said recently in any chat, use search_messages with from set to them.',
    'Returns JSON.',
  ].join(' '),
  inputSchema: {
    person: z.string().describe('Name, alias, phone, email or person_id.'),
    include_groups: z.boolean().default(true).describe('List the group chats you share.'),
    include_stats: z.boolean().default(true).describe('Message counts and the monthly breakdown.'),
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store, tz, monthKey, chatState } = peopleKit(ctx);
    const p = resolvePerson(store, a.person);
    const act = store.personActivity(p.personId);
    const lp = localParts(store.now(), tz);
    // Rolling 12 months, but never before the first message (no leading zero months for new contacts).
    const firstKey = act.firstAt !== undefined ? monthKey(act.firstAt) : undefined;
    const byMonth: Record<string, number> = {};
    for (let i = 11; firstKey && i >= 0; i--) {
      const d = new Date(Date.UTC(lp.y, lp.mo - 1 - i, 1));
      const k = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
      if (k >= firstKey) byMonth[k] = act.byMonth[k] ?? 0;
    }
    const dms = act.dmChatIds.map((id) => store.summarizeChat(id));
    return jsonResult({
      // personSummary carries last_from_you (code-redacted snippet) and needs_reply (over 1:1 chats).
      ...personSummary(ctx, p),
      ...(p.note ? { note: p.note } : {}),
      labels: p.labels,
      dm_chats: dms.map((s) => ({
        chat_id: s.chat.chatId,
        service: s.chat.service,
        via: prettyAddress(chatGuidIdentifier(s.chat.chatId)),
        ...chatState(s),
      })),
      ...(a.include_groups
        ? {
            groups: act.groupChatIds.map((id) => {
              const s = store.summarizeChat(id);
              return { chat_id: id, title: s.title, members: s.chat.participantIds.length + 1, ...chatState(s) };
            }),
          }
        : {}),
      ...(a.include_stats
        ? {
            stats: {
              total: act.messageCount,
              in_dms: act.dmMessageCount,
              sent_by_you_in_dms: act.sentByMe,
              sent_by_them: act.sentByThem,
              sent_by_them_in_groups: act.sentByThemInGroups,
              first_message_at: act.firstAt ? fmtIso(act.firstAt, tz) : null,
              days_each_started_the_conversation: act.daysStarted,
              active_days_in_dms: act.daysStarted.you + act.daysStarted.them,
              by_month_last_12: byMonth,
            },
          }
        : {}),
      more: `search_messages(from="${p.personId}") lists their messages across all chats, groups included.`,
      time_zone: tz,
    });
  },
});
