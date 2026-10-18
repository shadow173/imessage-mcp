import * as z from 'zod/v4';
import { senderLabels } from '../../domain/naming.js';
import { decodeCursor, encodeCursor, zEpochMs } from '../../lib/cursor.js';
import { ToolError } from '../../lib/errors.js';
import { chatHeader, chatJson, messageJson, renderLine, UNTRUSTED_NOTICE } from '../../lib/format.js';
import { requireChat } from '../../lib/resolve.js';
import { fmtDay, fmtRange, resolveRange, type TimeRange } from '../../lib/time.js';
import type { Message, MessageFilter, MsgKey } from '../../store/types.js';
import { parseFrom } from '../args.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, renderOpts, textResult } from '../results.js';
import { zChatReq, zFormat, zFrom, zLimit, zTime } from '../schemas.js';
import { fromKey, fromOfKey, readKit, unreadIncoming, zId } from './common.js';

const RC_FIX =
  'Pass older_cursor or newer_cursor exactly as read_conversation returned it for this chat, or omit cursor to start from the latest messages.';

/** read_conversation: a position in one chat plus the caller's window, from filter and system-event flag. */
const RcCursor = z.object({
  k: z.literal('rc'),
  chat: zId,
  /** Which way the next page goes from the position. */
  dir: z.enum(['older', 'newer']),
  /** Position: the sent time and id of the edge message. */
  t: zEpochMs,
  id: zId,
  /** The resolved after/before window. */
  w: z.object({ after: zEpochMs.optional(), before: zEpochMs.optional() }).optional(),
  /** from as fromKey: "me", "others" or a person_id. */
  f: zId.optional(),
  /** 1 = include system events. */
  s: z.literal(1).optional(),
});

export const readConversation = defineTool({
  name: 'read_conversation',
  tier: 'read',
  title: 'Read a conversation',
  description: [
    'Read one conversation as a transcript, oldest to newest within the page.',
    'It starts at the newest messages; start_from=oldest starts at the first message, and after/before/on limit it to a time window (with only after, reading starts there and pages forward).',
    'Page with older_cursor/newer_cursor as far as you need; a cursor keeps the window and from filter, so chat and cursor are enough.',
    'Reactions appear on the message they react to, edited or unsent messages are marked, and unread messages from others start with •.',
    'A person means your most recent 1:1 with them; their other 1:1 threads are listed under the header.',
    'For one message and its surroundings, use get_message.',
  ].join(' '),
  inputSchema: {
    chat: zChatReq,
    after: zTime('On or after'),
    before: zTime('Before (exclusive)'),
    on: zTime(
      'Only this local day or month (2026-03-30 or 2026-03); a relative value or datetime means the whole day containing it',
    ),
    from: zFrom,
    start_from: z
      .enum(['newest', 'oldest'])
      .optional()
      .describe(
        'Which end to start reading from, within after/before/on if set. Default: oldest when only after is set, otherwise newest. Ignored when cursor is set.',
      ),
    limit: zLimit(50, 200),
    cursor: z
      .string()
      .optional()
      .describe(
        "older_cursor or newer_cursor from a previous read_conversation call on this chat. It keeps that call's after/before/on and from.",
      ),
    include_system_events: z.boolean().optional().describe('Show renames, joins and leaves. Default: false.'),
    max_chars_per_message: z
      .number()
      .int()
      .min(50)
      .max(20000)
      .default(1000)
      .describe('50–20000. Longer texts are cut with a marker; get_message returns the full text.'),
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store, tz, iso, fromLabel, otherDms, siblingJson, siblingLine } = readKit(ctx);
    const chat = requireChat(store, a.chat);
    const now = store.now();
    let c: z.infer<typeof RcCursor> | undefined;
    if (a.cursor) {
      c = decodeCursor(a.cursor, RcCursor, RC_FIX);
      if (c.chat !== chat.chatId)
        throw new ToolError(
          'invalid_cursor',
          'That cursor belongs to a different conversation.',
          `Pass chat="${c.chat}" with it, or omit cursor to start from the latest messages.`,
        );
    }
    // A cursor alone keeps the window it was made with, so paging never drifts out of range.
    const ownWindow = a.after !== undefined || a.before !== undefined || a.on !== undefined;
    const range: TimeRange =
      ownWindow || !c?.w ? resolveRange({ after: a.after, before: a.before, on: a.on }, tz, now) : c.w;
    const from = a.from !== undefined ? parseFrom(store, a.from) : fromOfKey(c?.f);
    const includeSystem = a.include_system_events ?? c?.s === 1;
    const filter: MessageFilter = { ...range, from, includeSystem };
    let before: MsgKey | undefined;
    let after: MsgKey | undefined;
    if (c) {
      if (c.dir === 'older') before = { t: c.t, id: c.id };
      else after = { t: c.t, id: c.id };
    }
    const start = a.start_from ?? (range.after !== undefined && range.before === undefined ? 'oldest' : 'newest');
    const res = store.pageChat(chat.chatId, filter, {
      limit: a.limit,
      before,
      after,
      anchor: start === 'oldest' ? 'start' : 'end',
    });
    const page = res.items;
    const hasRange = range.after !== undefined || range.before !== undefined;
    const fk = fromKey(from);
    const key = (m: Message, dir: 'older' | 'newer') =>
      encodeCursor({
        k: 'rc',
        chat: chat.chatId,
        dir,
        t: m.sentAt,
        id: m.messageId,
        ...(hasRange ? { w: range } : {}),
        ...(fk ? { f: fk } : {}),
        ...(includeSystem ? { s: 1 } : {}),
      });
    const older = res.hasOlder && page.length ? key(page[0], 'older') : null;
    const newer = res.hasNewer && page.length ? key(page[page.length - 1], 'newer') : null;
    const opts = renderOpts(ctx, a.max_chars_per_message);
    const sibs = otherDms(chat, hasRange || from ? filter : undefined);
    const span = () => ({
      first: store.pageChat(chat.chatId, {}, { limit: 1, anchor: 'start' }).items[0],
      last: store.summarizeChat(chat.chatId).lastMessage,
    });
    if (a.format === 'json') {
      const sp = page.length ? undefined : span();
      return jsonResult(
        {
          chat: chatJson(store, store.summarizeChat(chat.chatId), opts),
          time_zone: tz,
          range: { after: iso(range.after), before: iso(range.before) },
          total_in_range: res.total,
          messages: page.map((m) => messageJson(store, m, opts)),
          older_cursor: older,
          newer_cursor: newer,
          ...(sp ? { conversation_span: { first_at: iso(sp.first?.sentAt), last_at: iso(sp.last?.sentAt) } } : {}),
          ...(sibs.length ? { other_dm_chats: sibs.map(siblingJson) } : {}),
        },
        { untrusted: true },
      );
    }
    const labels = senderLabels(store, chat);
    const rangeText = fmtRange(range, tz, now);
    const out = [chatHeader(store, chat)];
    if (sibs.length) out.push(siblingLine(chat, sibs, hasRange ? 'in range' : from ? `from ${fromLabel(from)}` : ''));
    out.push(UNTRUSTED_NOTICE);
    if (!page.length) {
      const { first, last } = span();
      out.push(
        `No messages${from ? ` from ${fromLabel(from)}` : ''}${rangeText ? ` · ${rangeText}` : ''}. ${first && last ? `This chat runs ${fmtDay(first.sentAt, tz, now)} – ${fmtDay(last.sentAt, tz, now)}.` : 'This chat has no messages.'}`,
      );
    } else {
      const head = [`${page.length} of ${res.total} messages`];
      if (rangeText) head.push(rangeText);
      if (from) head.push(`from ${fromLabel(from)}`);
      if (res.hasOlder) head.push('more older');
      else if (range.after === undefined && !from) head.push('start of conversation');
      if (res.hasNewer) head.push('more newer');
      out.push(head.join(' · '));
    }
    if (older) out.push(`older → cursor ${older}`);
    const anyUnread = page.some(unreadIncoming);
    out.push(...page.map((m) => renderLine(store, m, labels, opts, unreadIncoming(m) ? '• ' : anyUnread ? '  ' : '')));
    if (newer) out.push(`newer → cursor ${newer}`);
    return textResult(out.join('\n'));
  },
});
