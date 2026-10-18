import * as z from 'zod/v4';
import { normLabel, senderLabels } from '../../domain/naming.js';
import { ToolError } from '../../lib/errors.js';
import {
  akaOf,
  chatJson,
  isUnknownDm,
  messageJson,
  needsReplyTriage,
  renderLine,
  UNTRUSTED_NOTICE,
} from '../../lib/format.js';
import { foldBreaks, plural } from '../../lib/text.js';
import { fmtDueIn, fmtIso, fmtShort, resolveRange } from '../../lib/time.js';
import type { Chat, ChatSummary, Message, Reminder } from '../../store/types.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, renderOpts, textResult } from '../results.js';
import { zFormat, zTime } from '../schemas.js';
import { dismissOf, readKit, unreadIncoming } from './common.js';

const hasLabel = (chat: Chat, lbl: string) => chat.labels.some((l) => normLabel(l) === lbl);

export const catchUp = defineTool({
  name: 'catch_up',
  tier: 'read',
  title: 'Catch up',
  description: [
    'What needs attention: unread conversations, chats waiting on your reply, and due and upcoming reminders, each with its latest messages. 1:1 chats come before groups under Unread.',
    "Waiting on your reply lists chats where someone else spoke last in the past 14 days and that aren't already under Unread; groups, broadcasts and unknown senders come last.",
    'Cut lists say how many more there are.',
    'Use it for "what did I miss" or a daily summary.',
    'Verification codes are hidden unless the owner allows them.',
  ].join(' '),
  inputSchema: {
    since: zTime(
      "Instead of Messages' unread state, list chats where someone else wrote on or after this time (read or not); chats still waiting on your reply from before then are listed separately",
    ),
    include_needs_reply: z
      .boolean()
      .default(true)
      .describe(
        'Also list read chats where someone else sent the last message in the past 14 days. Marking a chat read does not remove it; replying does. false = unread chats and reminders only.',
      ),
    messages_per_chat: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe(
        'Latest messages shown per chat. When a chat has more unread than this, the result says how many were left out and where they start.',
      ),
    max_chats: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Chats per section. A cut section says how many more there are.'),
    senders: z
      .enum(['known', 'unknown', 'all'])
      .default('known')
      .describe('known: people in Contacts and groups. unknown: numbers not in Contacts. all: both.'),
    label: z
      .string()
      .optional()
      .describe(
        'Only chats with this label (case and a leading # ignored). label_conversation with no chat lists the labels.',
      ),
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store, tz, iso, chatTitleOf, reminderJson, dismissedByName, dismissedJson } = readKit(ctx);
    const now = store.now();
    const since = a.since ? resolveRange({ after: a.since }, tz, now).after : undefined;
    const lbl = a.label?.trim() ? normLabel(a.label) : undefined;
    if (lbl && !store.chats().some((c) => hasLabel(c, lbl))) {
      const counts = store.labelCounts();
      throw new ToolError(
        'label_not_found',
        `No conversation has label "${a.label!.trim()}".`,
        counts.length
          ? `Labels: ${counts.map((l) => `${l.name} (${l.count})`).join(', ')}. Ask the user which one, or use find.`
          : 'No labels exist yet; add one with label_conversation.',
      );
    }
    const all = store.chatSummaries();
    const activeSince =
      since !== undefined
        ? new Set(
            store
              .listMessages({ from: { kind: 'others' }, after: since }, { order: 'desc', limit: 5000, offset: 0 })
              .items.map((m) => m.chatId),
          )
        : null;
    const inScope = (s: ChatSummary, senders = a.senders) =>
      !!s.lastMessage &&
      (senders === 'all' || (senders === 'unknown') === s.unknownSender) &&
      (!lbl || hasLabel(s.chat, lbl));
    const isNew = (s: ChatSummary) => (activeSince ? activeSince.has(s.chat.chatId) : s.unreadCount > 0);
    const sums = all.filter((s) => inScope(s));
    const order = (x: ChatSummary, y: ChatSummary) =>
      (x.chat.type === y.chat.type ? 0 : x.chat.type === 'dm' ? -1 : 1) ||
      y.lastMessage!.sentAt - x.lastMessage!.sentAt;
    // Totals come from the full lists, so overflow unread chats never slide into the waiting section.
    const unreadAll = sums.filter(isNew).sort(order);
    const unread = unreadAll.slice(0, a.max_chats);
    const newIds = new Set(unreadAll.map((s) => s.chat.chatId));
    const waitingAll = a.include_needs_reply
      ? sums
          .filter((s) => s.needsReply && !newIds.has(s.chat.chatId))
          .map((s) => ({ s, t: needsReplyTriage(store, s) }))
          .sort((x, y) => x.t.rank - y.t.rank || y.s.lastMessage!.sentAt - x.s.lastMessage!.sentAt)
      : [];
    const waiting = waitingAll.slice(0, a.max_chats);
    const waitIds = new Set(waitingAll.map((x) => x.s.chat.chatId));
    const olderUnread = activeSince
      ? sums.filter((s) => s.unreadCount > 0 && !newIds.has(s.chat.chatId) && !waitIds.has(s.chat.chatId)).length
      : 0;
    const reminders = store.reminders().filter((r) => {
      if (!lbl) return true;
      const c = store.chat(r.chatId);
      return !!c && hasLabel(c, lbl);
    });
    const due = reminders.filter((r) => r.remindAt <= now);
    const upcoming = reminders.filter((r) => r.remindAt > now);
    const autoDismissed = store.dismissedReminders().filter((d) => {
      if (!lbl) return true;
      const c = store.chat(d.chatId);
      return !!c && hasLabel(c, lbl);
    });
    const hiddenUnknown = a.senders === 'known' ? all.filter((s) => inScope(s, 'unknown') && isNew(s)).length : 0;
    const recent = (chatId: string) => store.pageChat(chatId, {}, { limit: a.messages_per_chat, anchor: 'end' }).items;
    const unseen = (s: ChatSummary, msgs: Message[]) => {
      const n = s.unreadCount - msgs.filter(unreadIncoming).length;
      return n > 0
        ? {
            n,
            first: store.pageChat(s.chat.chatId, { unreadOnly: true }, { limit: 1, anchor: 'start' }).items[0] as
              | Message
              | undefined,
          }
        : undefined;
    };
    if (a.format === 'json') {
      const block = (s: ChatSummary) => {
        const msgs = recent(s.chat.chatId);
        const u = unseen(s, msgs);
        return {
          ...chatJson(store, s, renderOpts(ctx)),
          messages: msgs.map((m) => messageJson(store, m, renderOpts(ctx, 500))),
          ...(u
            ? {
                unread_not_shown: u.n,
                first_unread_at: iso(u.first?.sentAt),
                first_unread_message_id: u.first?.messageId ?? null,
              }
            : {}),
        };
      };
      return jsonResult(
        {
          as_of: fmtIso(now, tz),
          mode: since !== undefined ? 'since' : 'unread',
          since: iso(since),
          unread: unread.map(block),
          unread_total: unreadAll.length,
          needs_reply: waiting.map((x) => block(x.s)),
          needs_reply_total: waitingAll.length,
          due_reminders: due.map(reminderJson),
          upcoming_reminders: upcoming.map(reminderJson),
          ...(autoDismissed.length ? { auto_dismissed_reminders: autoDismissed.map(dismissedJson) } : {}),
          hidden_unknown_unread: hiddenUnknown,
          ...(activeSince ? { older_unread_not_shown: olderUnread } : {}),
        },
        { untrusted: true },
      );
    }
    const out = [UNTRUSTED_NOTICE, `As of ${fmtShort(now, tz, now)}`];
    const scopeArgs = ` senders=${a.senders}${lbl ? ` label=${lbl}` : ''}`;
    const section = (
      title: string,
      list: ChatSummary[],
      total: number,
      listCall: string,
      tag?: (s: ChatSummary) => string | undefined,
    ) => {
      out.push('', `${title} (${list.length}${total > list.length ? ` of ${total}` : ''})`);
      if (!list.length) out.push('  none');
      for (const s of list) {
        const labels = senderLabels(store, s.chat);
        const aka = s.chat.type === 'dm' && s.chat.participantIds[0] ? akaOf(store, s.chat.participantIds[0]) : [];
        const t = tag?.(s);
        out.push(
          foldBreaks(
            `■ ${s.title} · ${s.chat.type === 'dm' ? '1:1' : 'group'}${aka.length ? ` · aka ${aka.join(', ')}` : ''}${s.unknownSender || isUnknownDm(store, s.chat) ? ' · not in Contacts' : ''}${t ? ` · ${t}` : ''}${s.unreadCount ? ` · ${s.unreadCount} unread` : ''} · chat_id ${s.chat.chatId}`,
            ' ',
          ),
        );
        const msgs = recent(s.chat.chatId);
        const u = unseen(s, msgs);
        if (u)
          out.push(
            `  … ${u.n} earlier unread not shown${u.first ? ` · read_conversation chat=${s.chat.chatId} after=${fmtIso(u.first.sentAt, tz)}` : ''}`,
          );
        for (const m of msgs)
          out.push(renderLine(store, m, labels, renderOpts(ctx, 400), unreadIncoming(m) ? '  • ' : '    '));
      }
      if (total > list.length)
        out.push(
          `  +${total - list.length} more not shown · ${total <= 50 && a.max_chats < 50 ? 'max_chats=50 to see more' : `list_conversations ${listCall}${scopeArgs}`}`,
        );
    };
    section(
      since !== undefined ? `New since ${fmtShort(since, tz, now)}` : 'Unread',
      unread,
      unreadAll.length,
      since !== undefined ? `active_after=${fmtIso(since, tz)}` : 'unread_only=true',
    );
    // group is in the kind and unknown senders say "not in Contacts", so only broadcasts need their own tag.
    if (a.include_needs_reply)
      section(
        since !== undefined ? 'Older, still waiting on your reply' : 'Waiting on your reply',
        waiting.map((x) => x.s),
        waitingAll.length,
        'needs_reply=true',
        (s) => (needsReplyTriage(store, s).label === 'broadcast' ? 'broadcast' : undefined),
      );
    const reminderLine = (r: Reminder) =>
      `  ⏰ ${chatTitleOf(r.chatId)} · ${fmtShort(r.remindAt, tz, now)} (${fmtDueIn(r.remindAt, now)})${r.note ? ` · ${r.note}` : ''} · dismiss_when ${dismissOf(r)} · chat_id ${r.chatId}`;
    out.push('', `Reminders due (${due.length})`, ...(due.length ? due.map(reminderLine) : ['  none']));
    if (upcoming.length) out.push('', `Upcoming reminders (${upcoming.length})`, ...upcoming.map(reminderLine));
    if (autoDismissed.length) {
      out.push(
        '',
        `Reminders auto-dismissed in the past 7 days (${autoDismissed.length})`,
        ...autoDismissed.map(
          (d) =>
            `  ✓ ${chatTitleOf(d.chatId)}${d.note ? ` · ${d.note}` : ''} · auto-dismissed by ${dismissedByName(d) === 'you' ? 'your' : `${dismissedByName(d)}'s`} message${d.dismissedBy ? ` #${d.dismissedBy}` : ''} ${fmtShort(d.dismissedAt, tz, now)} (dismiss_when ${d.dismissWhen}) · chat_id ${d.chatId}`,
        ),
      );
    }
    if (olderUnread)
      out.push(
        '',
        `${plural(olderUnread, 'unread chat')} with messages before ${fmtShort(since!, tz, now)} not shown · omit since to include`,
      );
    if (hiddenUnknown)
      out.push(
        '',
        `${plural(hiddenUnknown, `${since !== undefined ? 'active' : 'unread'} chat`)} from unknown senders hidden · senders=all to include`,
      );
    return textResult(out.join('\n'));
  },
});
