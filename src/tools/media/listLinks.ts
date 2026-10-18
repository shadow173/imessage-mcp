import * as z from 'zod/v4';
import { checkCursorHash, cursorHash, encodeCursor, offsetCursor } from '../../lib/cursor.js';
import { ToolError } from '../../lib/errors.js';
import { linkOf, messageText, UNTRUSTED_NOTICE } from '../../lib/format.js';
import { plural } from '../../lib/text.js';
import { fmtIso, fmtShort } from '../../lib/time.js';
import { normDomain, queryTerms } from '../../store/match.js';
import { type ListPage, ME, type MessageFilter } from '../../store/types.js';
import { parseFrom } from '../args.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, textResult } from '../results.js';
import { zChatScopeOpt, zCursor, zFormat, zFrom, zLimit, zTime } from '../schemas.js';
import { mediaKit } from './common.js';

/** lq: the first page fell back to the URL/title substring filter (index still building), so later pages keep it. */
const LlCursor = offsetCursor('ll').extend({ lq: z.boolean().optional() });

/**
 * Unquoted words with . / : become phrases, so "stays.example" tokenizes like the indexed URL instead of collapsing
 * to one word.
 */
const ftsSafe = (q: string) =>
  q.replace(/"[^"]*"|\S+/g, (w) => (w.startsWith('"') || !/[./:]/.test(w) ? w : `"${w.replace(/"/g, '')}"`));

export const listLinks = defineTool({
  name: 'list_links',
  tier: 'read',
  title: 'List shared links',
  description: [
    'Links shared in messages, with their preview titles, newest first.',
    'Use it for "the link Sam sent about the cabin".',
    'Filter by chat, sender, site, or words in the title or URL.',
    'For what someone shared in any chat (groups too), set from to that person; chat set to a person covers only your 1:1 threads with them.',
  ].join(' '),
  inputSchema: {
    query: z.string().optional().describe('Words in the link title or URL. All must appear, in any order.'),
    domain: z
      .string()
      .optional()
      .describe('Site host, e.g. airbnb.com (subdomains included). Combined with query: both must match.'),
    chat: zChatScopeOpt,
    from: zFrom,
    after: zTime('On or after'),
    before: zTime('Before (exclusive)'),
    on: zTime('Only this day or month (excludes after/before)'),
    limit: zLimit(30, 100),
    cursor: zCursor,
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store, tz, titleOf, origin, paging, frozenRange, showing, scopeOf, partnerElsewhere } = mediaKit(ctx);
    const { c, offset, asOf } = paging(a.cursor, LlCursor);
    const scope = scopeOf(a.chat, 'list_links');
    const from = parseFrom(store, a.from);
    const query = a.query?.trim() || undefined;
    const domain = a.domain ? normDomain(a.domain) || undefined : undefined;
    const h = cursorHash({ chats: scope?.chatIds, from, query, domain, after: a.after, before: a.before, on: a.on });
    if (c) checkCursorHash(c, h);
    const range = frozenRange(a, asOf);
    // query goes through the search index (titles included); while it builds, the URL/title substring filter stands
    // in, and the cursor keeps that mode.
    let substring = !!c?.lq;
    const run = (f: MessageFilter, o: { limit: number; offset: number }): ListPage => {
      const base: MessageFilter = { ...f, hasLink: true, linkDomain: domain, ...range };
      if (!query) return store.listMessages(base, { order: 'desc', ...o });
      if (!substring) {
        try {
          return store.listMessages({ ...base, text: ftsSafe(query) }, { order: 'desc', ...o });
        } catch (e) {
          if (!(e instanceof ToolError && e.code === 'index_building')) throw e;
          substring = true;
        }
      }
      // The substring fallback reads raw titles and URLs, so a match that only a hidden code satisfies is dropped
      // (search never confirms a code).
      const res = store.listMessages({ ...base, linkQuery: query }, { order: 'desc', ...o });
      if (!ctx.cfg.redactCodes) return res;
      const words = queryTerms(query);
      const items = res.items.filter((m) => {
        const l = linkOf(store, m, true);
        const hay = `${l?.title ?? ''} ${l?.url ?? ''} ${messageText(store, m, { redactCodes: true })}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      return { items, total: res.total - (res.items.length - items.length) };
    };
    const { items: page, total } = run({ chatIds: scope?.chatIds, from }, { limit: a.limit, offset });
    const nextCursor =
      page.length && offset + page.length < total
        ? encodeCursor({ k: 'll', o: offset + page.length, h, as_of: asOf, ...(substring ? { lq: true } : {}) })
        : null;
    const rows = page
      .map((m) => ({ m, link: linkOf(store, m, ctx.cfg.redactCodes) }))
      .map(({ m, link }) => ({
        url: link?.url ?? '',
        title: link?.title,
        site: link?.site,
        shared_by: m.senderId === ME ? 'me' : store.personName(m.senderId),
        at: fmtIso(m.sentAt, tz),
        chat_id: m.chatId,
        chat_title: titleOf(store.chat(m.chatId)),
        message_id: m.messageId,
      }));

    const notes: string[] = [];
    let empty = '';
    if (!page.length) {
      const filtered = !!(from || query || domain || a.after || a.before || a.on);
      if (scope?.chat.type === 'dm' && offset === 0) {
        const pid = scope.personId ?? scope.chat.participantIds[0];
        const name = store.personName(pid);
        empty = `No ${filtered ? 'matching ' : ''}links in your 1:1 ${scope.chatIds.length > 1 ? 'threads' : 'chat'} with ${name}.`;
        if (partnerElsewhere(from, pid)) {
          const n = run({ from: { kind: 'person', personId: pid } }, { limit: 1, offset: 0 }).total;
          if (n)
            notes.push(
              `${name} shared ${plural(n, 'matching link')} in other chats: call list_links again with from="${pid}" and no chat.`,
            );
        }
      } else
        empty = scope ? `No ${filtered ? 'matching ' : ''}links in ${store.chatTitle(scope.chat)}.` : 'No links match.';
      if (query)
        notes.push(
          'Try fewer words, or search_messages with the same words and no has_link: what people write about a link is often a separate message next to it.',
        );
    }

    if (a.format === 'json')
      return jsonResult(
        { total, links: rows, next_cursor: nextCursor, ...(notes.length ? { hint: notes.join(' ') } : {}) },
        { untrusted: rows.length > 0 },
      );
    if (!rows.length) return textResult([empty, ...notes].join('\n'));
    const out = [
      showing(total, offset, rows.length, 'link'),
      UNTRUSTED_NOTICE,
      ...page.map(
        (m, i) =>
          `• ${rows[i].title || rows[i].site || rows[i].url}\n  ${rows[i].url} · ${origin('shared by', m.senderId, m.chatId)} · ${fmtShort(m.sentAt, tz, store.now())} · message_id ${m.messageId} · chat_id ${m.chatId}`,
      ),
    ];
    if (nextCursor) out.push(`more → cursor ${nextCursor}`);
    return textResult(out.join('\n'));
  },
});
