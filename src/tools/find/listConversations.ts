import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { normLabel } from '../../domain/naming.js';
import { checkCursorHash, cursorHash, decodeCursor, encodeCursor, offsetCursor, zEpochMs } from '../../lib/cursor.js';
import { ToolError } from '../../lib/errors.js';
import { chatJson, chatLine, needsReplyTriage, UNTRUSTED_NOTICE } from '../../lib/format.js';
import { matchPeople, resolvePerson } from '../../lib/resolve.js';
import { plural } from '../../lib/text.js';
import { fmtIso, resolveRange } from '../../lib/time.js';
import type { ChatSummary } from '../../store/types.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, renderOpts, textResult } from '../results.js';
import { zCursor, zFormat, zLimit, zTime } from '../schemas.js';
import { convoMatch, SERVICE, withFormerly } from './common.js';

/**
 * list_conversations: sort=recent resumes after the keyset (r, t, u, n, id) of the last chat returned; sort=unread and
 * sort=name skip the chats listed in x.
 */
const LcCursor = offsetCursor('lc').extend({
  /** The sort it was made with. */
  s: z.enum(['recent', 'unread', 'name']).optional(),
  /** Keyset of the last chat returned: needs_reply rank, last message time, unread count, title, chat_id. */
  r: z.number().int().min(0).max(3).optional(),
  t: zEpochMs.optional(),
  u: z.number().int().min(0).optional(),
  n: z.string().max(10_000).optional(),
  id: z.string().max(1000).optional(),
  /** chatTag of every chat already returned, concatenated. */
  x: z
    .string()
    .regex(/^[\w-]*$/)
    .max(600_000)
    .optional(),
});
interface LcKey {
  r: number;
  t: number;
  u: number;
  n: string;
  id: string;
}

/**
 * 6-char tag of a chat_id; sort=unread/name cursors carry the tags of every chat already returned (36 bits: collisions
 * are negligible).
 */
const chatTag = (chatId: string) => createHash('sha256').update(chatId).digest('base64url').slice(0, 6);
const tagsOf = (x: string | undefined) => new Set(x ? (x.match(/.{6}/g) ?? []) : []);

export const listConversations = defineTool({
  name: 'list_conversations',
  tier: 'read',
  title: 'List conversations',
  description: [
    'List conversations, most recent first, with unread counts and the last message.',
    'Set person to get every chat that person is in, type=group for group chats, label for chats you labelled, and needs_reply for chats waiting on your reply.',
    'Unnamed group chats get a title built from participant names.',
    'In json, participants lists the other people (first 10; participants_omitted counts the rest; get_conversation has everyone) and participant_count includes you.',
    'Pages stay stable while you act on results; chats with new messages after page 1 are listed in new_activity_since_first_page.',
  ].join(' '),
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe('Matches the conversation title (or a former title), a participant name, or a label.'),
    person: z.string().optional().describe('Only chats this person is in.'),
    type: z.enum(['dm', 'group', 'any']).default('any'),
    service: z.enum(['any', 'imessage', 'sms', 'rcs']).default('any'),
    unread_only: z.boolean().default(false),
    needs_reply: z
      .boolean()
      .default(false)
      .describe(
        'Only chats waiting on you: someone else sent the last message within 14 days (short codes excluded); groups, broadcasts and unknown senders sort last and are labelled.',
      ),
    label: z.string().optional().describe('A label added with label_conversation (case and a leading # are ignored).'),
    senders: z
      .enum(['known', 'unknown', 'all'])
      .default('all')
      .describe("unknown = numbers not in Contacts, like Messages' Unknown Senders filter."),
    active_after: zTime('Last message on or after'),
    active_before: zTime('Last message before (exclusive)'),
    sort: z.enum(['recent', 'unread', 'name']).default('recent'),
    limit: zLimit(20, 100),
    cursor: zCursor,
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store } = ctx;
    const tz = store.timeZone;
    const personId = a.person ? resolvePerson(store, a.person).personId : undefined;
    const range = resolveRange({ after: a.active_after, before: a.active_before }, tz, store.now());
    const label = a.label !== undefined && normLabel(a.label) ? normLabel(a.label) : undefined;
    if (label !== undefined) {
      const counts = store.labelCounts();
      if (!counts.some((l) => normLabel(l.name) === label)) {
        const stem = (s: string) => normLabel(s).replace(/s$/, '');
        const sorted = [...counts].sort(
          (x, y) => Number(stem(y.name) === stem(label)) - Number(stem(x.name) === stem(label)),
        );
        throw new ToolError(
          'label_not_found',
          `No conversation has label "${a.label}".`,
          counts.length
            ? `Labels: ${sorted
                .slice(0, 20)
                .map((l) => `${l.name} (${l.count})`)
                .join(', ')}. Pass one of these as label, or use query to match titles and names.`
            : 'No labels exist yet; label_conversation adds them. Use query to match titles and names instead.',
        );
      }
    }
    const q = a.query?.trim() || undefined;
    const qPeople = q
      ? new Set(matchPeople(store, q, { fragments: true }).map((s) => s.item.personId))
      : new Set<string>();
    const formerly = new Map<string, string>();
    const list = store.chatSummaries().filter((s) => {
      const c = s.chat;
      if (!s.lastMessage) return false;
      if (q) {
        const m = convoMatch(s, q, qPeople);
        if (!m) return false;
        if (m.formerly) formerly.set(c.chatId, m.formerly);
      }
      if (personId && !c.participantIds.includes(personId)) return false;
      if (a.type !== 'any' && c.type !== a.type) return false;
      if (a.service !== 'any' && c.service !== SERVICE[a.service]) return false;
      if (a.unread_only && !s.unreadCount) return false;
      if (a.needs_reply && !s.needsReply) return false;
      if (label !== undefined && !c.labels.map(normLabel).includes(label)) return false;
      if (a.senders === 'known' && s.unknownSender) return false;
      if (a.senders === 'unknown' && !s.unknownSender) return false;
      if (range.after !== undefined && s.lastMessage.sentAt < range.after) return false;
      if (range.before !== undefined && s.lastMessage.sentAt >= range.before) return false;
      return true;
    });
    // One comparator sorts and finds where a keyset cursor resumes: needs_reply triage, the sort, then chat_id.
    const ranked = a.needs_reply && a.sort !== 'name';
    const keyOf = (s: ChatSummary): LcKey => ({
      r: ranked ? needsReplyTriage(store, s).rank : 0,
      t: s.lastMessage?.sentAt ?? 0,
      u: s.unreadCount,
      n: s.title,
      id: s.chat.chatId,
    });
    const cmp = (x: LcKey, y: LcKey) =>
      x.r - y.r ||
      (a.sort === 'name' ? x.n.localeCompare(y.n) : a.sort === 'unread' ? y.u - x.u || y.t - x.t : y.t - x.t) ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    const keyed = list.map((s) => ({ s, k: keyOf(s) })).sort((x, y) => cmp(x.k, y.k));
    const h = cursorHash({
      q,
      person: personId,
      type: a.type,
      service: a.service,
      unread_only: a.unread_only,
      needs_reply: a.needs_reply,
      label,
      senders: a.senders,
      after: a.active_after,
      before: a.active_before,
      sort: a.sort,
    });
    let start = 0,
      shown = 0,
      asOf = store.now(),
      paged = false;
    let seen: Set<string> | undefined,
      seenTags = '';
    if (a.cursor) {
      const c = decodeCursor(a.cursor, LcCursor);
      if (c.s !== undefined && c.s !== a.sort)
        throw new ToolError(
          'invalid_cursor',
          `That cursor came from sort=${c.s}, but this call uses sort=${a.sort}.`,
          `Pass sort=${c.s} with the cursor, or omit the cursor to start over.`,
        );
      checkCursorHash(c, h);
      paged = true;
      asOf = c.as_of ?? asOf;
      shown = c.o;
      if (c.id === undefined)
        start = c.o; // a cursor minted before keyset paging
      else if (c.x !== undefined && a.sort !== 'recent') {
        seen = tagsOf(c.x);
        seenTags = c.x;
      } else {
        const key: LcKey = { r: c.r ?? 0, t: c.t ?? 0, u: c.u ?? 0, n: c.n ?? '', id: c.id };
        const i = keyed.findIndex((x) => cmp(x.k, key) > 0);
        start = i < 0 ? keyed.length : i;
      }
    }
    // sort=unread and sort=name keys change as you act (mark_read, rename), so their later pages skip the chats
    // already returned instead of resuming at a key: nothing repeats and a chat that moved is still listed.
    // sort=recent keeps the keyset.
    const rest = seen ? keyed.filter((x) => !seen!.has(chatTag(x.s.chat.chatId))) : keyed.slice(start);
    const rows = rest.slice(0, a.limit);
    const page = rows.map((x) => x.s);
    const lastKey = rows[rows.length - 1]?.k;
    const total = keyed.length;
    const tags = a.sort !== 'recent' ? seenTags + rows.map((x) => chatTag(x.s.chat.chatId)).join('') : undefined;
    const nextCursor =
      lastKey && rows.length < rest.length
        ? encodeCursor({
            k: 'lc',
            o: shown + rows.length,
            h,
            s: a.sort,
            ...(ranked ? { r: lastKey.r } : {}),
            t: lastKey.t,
            ...(a.sort === 'unread' ? { u: lastKey.u } : {}),
            ...(a.sort === 'name' ? { n: lastKey.n } : {}),
            id: lastKey.id,
            ...(tags !== undefined ? { x: tags } : {}),
            as_of: asOf,
          })
        : null;
    // sort=recent: chats with new messages since page 1 sort above the cursor, where later pages can't reach them.
    // Other sorts: returned chats that got new messages.
    const moved = !paged
      ? []
      : seen
        ? keyed
            .filter((x) => seen!.has(chatTag(x.s.chat.chatId)) && x.k.t > asOf)
            .slice(0, 10)
            .map((x) => x.s)
        : a.sort === 'recent'
          ? keyed
              .slice(0, start)
              .filter((x) => x.k.t > asOf)
              .slice(0, 10)
              .map((x) => x.s)
          : [];
    if (a.format === 'json') {
      return jsonResult(
        {
          total,
          conversations: page.map((s) => ({
            ...chatJson(store, s, renderOpts(ctx)),
            ...(formerly.has(s.chat.chatId) ? { formerly: formerly.get(s.chat.chatId) } : {}),
          })),
          next_cursor: nextCursor,
          ...(moved.length
            ? {
                new_activity_since_first_page: moved.map((s) => ({ chat_id: s.chat.chatId, title: s.title })),
                as_of: fmtIso(asOf, tz),
              }
            : {}),
        },
        { untrusted: true },
      );
    }
    const movedLine = moved.length
      ? [
          `${plural(moved.length, 'chat')} got new messages after page 1: ${moved.map((s) => s.title).join(', ')} (re-list with active_after=${fmtIso(asOf, tz)})`,
        ]
      : [];
    if (!page.length)
      return textResult(
        [
          paged && total
            ? 'No more conversations: the earlier pages had them all.'
            : 'No conversations match those filters.',
          ...movedLine,
        ].join('\n'),
      );
    const out = [
      `${plural(total, 'conversation')} · showing ${shown + 1}–${shown + page.length}`,
      UNTRUSTED_NOTICE,
      ...page.map((s) => chatLine(store, withFormerly(s, formerly.get(s.chat.chatId)), renderOpts(ctx))),
      ...movedLine,
    ];
    if (nextCursor) out.push(`more → cursor ${nextCursor}`);
    return textResult(out.join('\n'));
  },
});
