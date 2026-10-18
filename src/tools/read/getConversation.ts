import * as z from 'zod/v4';
import { akaOf, chatJson } from '../../lib/format.js';
import { requireChat } from '../../lib/resolve.js';
import { fmtIso } from '../../lib/time.js';
import { ME } from '../../store/types.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, renderOpts } from '../results.js';
import { zChatReq } from '../schemas.js';
import { dismissOf, readKit } from './common.js';

export const getConversation = defineTool({
  name: 'get_conversation',
  tier: 'read',
  title: 'Conversation details',
  description: [
    'Details about one conversation: the full participant list with names, group renames and member changes, labels, reminders and activity stats. participants lists the other members; participant_count includes you.',
    'For a person it describes your most recent 1:1 with them, and other_dm_chats lists their other 1:1 threads.',
    'Use it for who is in a group or how active a chat is.',
    'It returns no message history; use read_conversation for that.',
  ].join(' '),
  inputSchema: {
    chat: zChatReq,
    include_stats: z.boolean().default(true),
    include_history: z.boolean().default(true).describe('Group renames and member changes.'),
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store, tz, dismissedJson, otherDms, siblingJson } = readKit(ctx);
    const chat = requireChat(store, a.chat);
    const act = store.chatActivity(chat.chatId);
    const bySender: Record<string, number> = {};
    for (const [id, n] of Object.entries(act.bySender)) bySender[id === ME ? 'You' : store.personName(id)] = n;
    const sibs = otherDms(chat);
    const groupEvents =
      a.include_history && chat.type === 'group'
        ? act.groupEvents.map((m) => ({
            at: fmtIso(m.sentAt, tz),
            by: store.personName(m.senderId),
            event: m.system!.detail,
          }))
        : undefined;
    const result: Record<string, unknown> = {
      ...chatJson(store, store.summarizeChat(chat.chatId), renderOpts(ctx)),
      participants: chat.participantIds.map((id) => {
        const aka = akaOf(store, id);
        return {
          person_id: id,
          name: store.personName(id),
          ...(aka.length ? { aka } : {}),
          handles: store.person(id)?.handles.map((h) => h.address) ?? [],
        };
      }),
      first_message_at: act.firstAt ? fmtIso(act.firstAt, tz) : null,
      ...(a.include_stats
        ? {
            stats: {
              total_messages: act.total,
              by_sender: bySender,
              last_30_days: act.last30Days,
              attachments: act.attachments,
              links: act.links,
            },
          }
        : {}),
      ...(groupEvents ? { group_events: groupEvents } : {}),
      ...(sibs.length ? { other_dm_chats: sibs.map(siblingJson) } : {}),
      reminders: store
        .reminders()
        .filter((r) => r.chatId === chat.chatId)
        .map((r) => ({
          reminder_id: r.reminderId,
          remind_at: fmtIso(r.remindAt, tz),
          note: r.note,
          dismiss_when: dismissOf(r),
        })),
    };
    const gone = store.dismissedReminders().filter((d) => d.chatId === chat.chatId);
    if (gone.length)
      result.auto_dismissed_reminders = gone.map((d) => {
        const { chat_id: _c, title: _t, ...j } = dismissedJson(d);
        return j;
      });
    // participants is now the full list, so the chatJson cut-off count no longer applies.
    delete result.participants_omitted;
    return jsonResult(result, { untrusted: !!result.last_message || !!groupEvents?.length });
  },
});
