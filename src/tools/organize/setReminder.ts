import * as z from 'zod/v4';
import { isShortCode } from '../../lib/address.js';
import { ToolError } from '../../lib/errors.js';
import { requireChat } from '../../lib/resolve.js';
import { fmtDueIn, fmtIso, fmtShort, parseFutureTime } from '../../lib/time.js';
import { DAY_MS, MINUTE_MS } from '../../lib/units.js';
import { type DismissedReminder, type DismissWhen, ME, type Reminder } from '../../store/types.js';
import type { Ctx } from '../context.js';
import { defineTool, LOCAL_WRITE } from '../registry.js';
import { jsonResult } from '../results.js';
import { zChatOpt, zOneOf } from '../schemas.js';

const DISMISS = ['i_reply', 'they_reply', 'never'] as const;
const DISMISS_ALIASES: Record<string, string> = {
  i_write: 'i_reply',
  me: 'i_reply',
  when_i_reply: 'i_reply',
  on_my_reply: 'i_reply',
  they_write: 'they_reply',
  them: 'they_reply',
  when_they_reply: 'they_reply',
  on_their_reply: 'they_reply',
  none: 'never',
  manual: 'never',
};

/** Helpers the organize tools share, bound to one request's context. */
function organizeKit(ctx: Ctx) {
  const { store } = ctx;

  /**
   * The owner's latest message answered an inbound one and is under 30 min old: a reminder set now means "remind me to
   * really reply".
   */
  const justAnswered = (chatId: string, now: number) => {
    const [prev, last] = store.pageChat(chatId, {}, { limit: 2, anchor: 'end' }).items;
    if (
      !prev ||
      !last ||
      last.senderId !== ME ||
      prev.senderId === ME ||
      now - last.sentAt > 30 * MINUTE_MS ||
      last.sentAt - prev.sentAt > 14 * DAY_MS
    )
      return false;
    const from = prev.senderAddress ?? store.person(prev.senderId)?.handles[0]?.address;
    return !from || !isShortCode(from);
  };
  return { store, justAnswered };
}

export const setReminder = defineTool({
  name: 'set_reminder',
  tier: 'org',
  title: 'Set a reminder',
  description: [
    'Save a follow-up on a conversation for a given time.',
    'Nothing is pushed to the owner\'s phone: once due it is listed in catch_up (and get_conversation), so tell the owner to check catch_up / "what did I miss" after that time rather than promising a notification.',
    'One reminder per conversation: setting another replaces it (returned as replaced).',
    'Pass dismiss_when to say what clears it: i_reply for "remind me to reply to Sam", they_reply for "nudge me if Sam hasn\'t answered".',
    'Without it: i_reply when a reply is owed there or the owner just sent a holding reply, else they_reply.',
    'A reminder a message cleared is listed as auto-dismissed (with that message id) in catch_up and get_conversation for 7 days.',
    'Call with no arguments to list pending reminders.',
  ].join(' '),
  inputSchema: {
    chat: zChatOpt,
    remind_at: z
      .string()
      .optional()
      .describe(
        "When: 30min, 2h, 1d, 2w, 3mo, tomorrow 09:00, or 2026-10-18T09:00 (owner's time zone). Must be in the future. A date alone means 09:00. Required unless clear.",
      ),
    note: z.string().optional().describe('What to follow up on; shown with the reminder.'),
    dismiss_when: zOneOf(DISMISS, DISMISS_ALIASES)
      .optional()
      .describe(
        'i_reply: the owner\'s next message in the chat clears it ("remind me to reply to Sam"). they_reply: the other side\'s next message clears it ("nudge me if Sam hasn\'t answered"). never: only clear=true removes it. Default: i_reply when the chat is waiting on the owner\'s reply or the owner just sent a holding reply there, else they_reply.',
      ),
    dismiss_on_reply: z
      .boolean()
      .optional()
      .describe('Older form of dismiss_when: true = they_reply, false = never. dismiss_when wins.'),
    clear: z.boolean().default(false).describe("Remove this chat's reminder."),
  },
  annotations: LOCAL_WRITE,
  handler: (a, ctx) => {
    const { store, justAnswered } = organizeKit(ctx);
    const now = store.now();
    const tz = store.timeZone;
    const local = (ms: number) => fmtShort(ms, tz, now);
    const brief = (r: Reminder) => ({
      reminder_id: r.reminderId,
      remind_at: fmtIso(r.remindAt, tz),
      note: r.note ?? null,
    });
    const dismissedJson = (d: DismissedReminder) => ({
      ...brief(d),
      dismiss_when: d.dismissWhen,
      auto_dismissed_at: fmtIso(d.dismissedAt, tz),
      dismissed_by: d.dismissedBy ?? null,
    });
    if (!a.chat) {
      if (a.remind_at || a.clear || a.note || a.dismiss_when || a.dismiss_on_reply !== undefined) {
        throw new ToolError(
          'chat_required',
          'Pass chat to set or clear a reminder.',
          'Add chat (a chat_id, group name or person), or call set_reminder with no arguments to list pending reminders.',
        );
      }
      const titleOf = (chatId: string) => {
        const c = store.chat(chatId);
        return c ? store.chatTitle(c) : chatId;
      };
      const dismissed = store.dismissedReminders();
      return jsonResult({
        reminders: store.reminders().map((r) => ({
          reminder_id: r.reminderId,
          chat_id: r.chatId,
          title: titleOf(r.chatId),
          remind_at: fmtIso(r.remindAt, tz),
          remind_at_local: local(r.remindAt),
          note: r.note ?? null,
          dismiss_when: r.dismissWhen,
          due: r.remindAt <= now,
        })),
        ...(dismissed.length
          ? {
              auto_dismissed: dismissed.map((d) => ({
                chat_id: d.chatId,
                title: titleOf(d.chatId),
                ...dismissedJson(d),
              })),
            }
          : {}),
      });
    }
    const c = requireChat(store, a.chat, { strict: true });
    const title = store.chatTitle(c);
    // reminders() prunes ones a reply already dismissed, so a dead reminder never shows up as replaced or removed.
    const prev = store.reminders().find((r) => r.chatId === c.chatId);
    if (a.clear) {
      store.setReminder(c.chatId, null, undefined, 'never');
      if (prev) return jsonResult({ chat_id: c.chatId, title, cleared: true, removed: brief(prev) });
      const auto = store.dismissedReminders().find((d) => d.chatId === c.chatId);
      return jsonResult({
        chat_id: c.chatId,
        title,
        cleared: false,
        had_reminder: false,
        removed: null,
        ...(auto ? { auto_dismissed: dismissedJson(auto) } : {}),
      });
    }
    if (!a.remind_at)
      throw new ToolError(
        'remind_at_required',
        'Pass remind_at to set a reminder, or clear=true to remove it.',
        'remind_at takes 30min, 2h, tomorrow 09:00 or 2026-10-18T09:00. Call set_reminder with no arguments to list reminders.',
      );
    const { at, assumed } = parseFutureTime(a.remind_at, tz, now, 'remind_at');
    const legacy: DismissWhen | undefined =
      a.dismiss_on_reply === undefined ? undefined : a.dismiss_on_reply ? 'they_reply' : 'never';
    const owed = !a.dismiss_when && !legacy && store.summarizeChat(c.chatId).needsReply;
    const holding = !a.dismiss_when && !legacy && !owed && justAnswered(c.chatId, now);
    const mode: DismissWhen = a.dismiss_when ?? legacy ?? (owed || holding ? 'i_reply' : 'they_reply');
    const why = a.dismiss_when
      ? 'as requested'
      : legacy
        ? `from dismiss_on_reply=${a.dismiss_on_reply}`
        : owed
          ? `default: ${title} is waiting on your reply`
          : holding
            ? 'default: your message minutes ago answered theirs, likely a holding reply'
            : 'default: no reply is owed';
    const effect =
      mode === 'i_reply'
        ? "the owner's next message there clears it, so set it again after any holding reply"
        : mode === 'never'
          ? 'only clear=true removes it'
          : `their next message clears it${owed || a.dismiss_when || legacy ? '' : '; pass dismiss_when=i_reply for "remind me to reply"'}`;
    const r = store.setReminder(c.chatId, at, a.note, mode)!;
    return jsonResult({
      reminder_id: r.reminderId,
      chat_id: c.chatId,
      title,
      remind_at: fmtIso(r.remindAt, tz),
      remind_at_local: local(r.remindAt),
      due_in: fmtDueIn(r.remindAt, now),
      ...(assumed ? { assumed } : {}),
      note: r.note ?? null,
      dismiss_when: r.dismissWhen,
      dismiss_on_reply: r.dismissOnReply,
      dismiss_note: `${r.dismissWhen} (${why}): ${effect}.`,
      ...(prev ? { replaced: brief(prev) } : {}),
    });
  },
});
