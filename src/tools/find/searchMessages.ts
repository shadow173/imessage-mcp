import * as z from 'zod/v4';
import { ATTACHMENT_KINDS, type AttachmentKind } from '../../domain/attachments.js';
import { checkCursorHash, cursorHash, decodeCursor, encodeCursor, offsetCursor } from '../../lib/cursor.js';
import { ToolError } from '../../lib/errors.js';
import { messageJson, UNTRUSTED_NOTICE } from '../../lib/format.js';
import { resolveChatScope, resolvePerson } from '../../lib/resolve.js';
import { plural } from '../../lib/text.js';
import { fmtIso, resolveRange } from '../../lib/time.js';
import type { MessageFilter, Service } from '../../store/types.js';
import { liftQueryTokens, parseFrom } from '../args.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, renderOpts, textResult } from '../results.js';
import { zChatScopeOpt, zCursor, zFormat, zFrom, zLimit, zList, zTime } from '../schemas.js';
import { hitLines, NOT_IN_FILES, queryWords, SERVICE } from './common.js';

const KIND_ALIASES: Record<string, string> = {
  photo: 'image',
  photos: 'image',
  images: 'image',
  picture: 'image',
  pictures: 'image',
  pic: 'image',
  pics: 'image',
  videos: 'video',
  voice: 'voice_memo',
  voicememo: 'voice_memo',
  voice_memos: 'voice_memo',
  voice_message: 'voice_memo',
  pdfs: 'pdf',
  doc: 'document',
  docs: 'document',
  documents: 'document',
  stickers: 'sticker',
};

const SmCursor = offsetCursor('sm');

export const searchMessages = defineTool({
  name: 'search_messages',
  tier: 'read',
  title: 'Search messages',
  description: [
    'Search message text across every conversation or inside one.',
    'All words must appear, in any order.',
    'A word of 3+ letters also matches as a prefix (cabin finds cabins); quote a word or phrase to match it exactly.',
    'Sorted by relevance unless you set sort.',
    'It covers message text, link titles and attachment filenames, not text inside photos or PDFs; for that, narrow list_attachments, then get_attachment mode=text.',
    'Use the filters rather than typing operators into query.',
    'For everything a person sent, in your 1:1 and in group chats, set from to that person; query is optional and chat_type=group narrows to groups.',
    'For what you sent them, set from=me and chat to them.',
    "For a person's whole 1:1 history across numbers and emails, set chat to the person or use with=person, chat_type=dm.",
    'Each hit has a message_id: pass it to get_message with context to read around it.',
  ].join(' '),
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe(
        'Words to match. Optional: filters alone are allowed. Gmail-style tokens like from:sam, after:2026-09-01 or has:attachment are understood.',
      ),
    chat: zChatScopeOpt,
    from: zFrom,
    with: z.string().optional().describe('Only conversations this person is in, groups included.'),
    chat_type: z.enum(['dm', 'group', 'any']).default('any'),
    service: z.enum(['any', 'imessage', 'sms', 'rcs']).default('any'),
    after: zTime('On or after'),
    before: zTime('Before (exclusive: before=2026-10-01 stops at the end of Sep 30)'),
    on: zTime(
      'On this day or month (2026-10-01 or 2026-10); a relative value or datetime means that whole day. Excludes after/before',
    ),
    has_attachment: z.boolean().optional(),
    attachment_type: zList(ATTACHMENT_KINDS, KIND_ALIASES)
      .optional()
      .describe(
        'Attachment kinds: image (photo), video, audio, voice_memo, pdf, document, sticker. One value or a list.',
      ),
    has_link: z.boolean().optional(),
    unread_only: z.boolean().default(false),
    context: z
      .number()
      .int()
      .min(0)
      .max(5)
      .default(0)
      .describe('Messages to show on each side of every hit (0–5). The hit is marked ▶.'),
    sort: z
      .enum(['relevance', 'newest', 'oldest'])
      .optional()
      .describe('Default: relevance with a query, newest without.'),
    limit: zLimit(20, 50),
    cursor: zCursor,
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store } = ctx;
    const tz = store.timeZone;
    const { text: query, tokens } = liftQueryTokens(a.query ?? '');
    const times = { after: a.after ?? tokens.after, before: a.before ?? tokens.before, on: a.on ?? tokens.on };
    const range = resolveRange(times, tz, store.now());
    const chatArg = a.chat ?? tokens.in;
    let scope: ReturnType<typeof resolveChatScope> | undefined;
    try {
      scope = chatArg ? resolveChatScope(store, chatArg) : undefined;
    } catch (e) {
      if (e instanceof ToolError && e.code === 'no_conversation')
        e.fix = `To search the group chats you share, use with="${chatArg}" instead of chat.`;
      throw e;
    }
    const withArg = a.with ?? tokens.with;
    const hasKinds = tokens.has
      .map((t) => KIND_ALIASES[t] ?? t)
      .filter((t): t is AttachmentKind => (ATTACHMENT_KINDS as readonly string[]).includes(t));
    const kinds = [...new Set([...((a.attachment_type ?? []) as AttachmentKind[]), ...hasKinds])];
    const filter: MessageFilter = {
      chatIds: scope?.chatIds,
      withPersonId: withArg ? resolvePerson(store, withArg).personId : undefined,
      from: parseFrom(store, a.from ?? tokens.from),
      chatType: a.chat_type === 'any' ? undefined : a.chat_type,
      service: a.service === 'any' ? undefined : (SERVICE[a.service] as Service),
      hasAttachment: a.has_attachment ?? (tokens.has.some((t) => /^(attachments?|files?)$/.test(t)) ? true : undefined),
      attachmentKinds: kinds.length ? kinds : undefined,
      hasLink: a.has_link ?? (tokens.has.some((t) => /^links?$/.test(t)) ? true : undefined),
      unreadOnly: a.unread_only || tokens.is.includes('unread'),
    };
    const sort = a.sort ?? (query ? 'relevance' : 'newest');
    // Raw time strings ("3d"), not epochs, so a relative window still matches on page 2.
    const h = cursorHash({
      text: query,
      sort,
      ...filter,
      chatIds: filter.chatIds ? [...filter.chatIds].sort() : undefined,
      times,
    });
    let offset = 0,
      asOf = store.now();
    if (a.cursor) {
      const c = decodeCursor(a.cursor, SmCursor);
      checkCursorHash(c, h);
      offset = c.o;
      asOf = c.as_of ?? asOf;
    }
    // Frozen at the first page, so messages arriving between pages don't shift the offsets.
    const bounded: MessageFilter = {
      ...filter,
      after: range.after,
      before: Math.min(range.before ?? Infinity, asOf + 1),
    };
    const res = query
      ? store.search({ ...bounded, text: query }, { sort, limit: a.limit, offset })
      : store.listMessages(bounded, { order: sort === 'oldest' ? 'asc' : 'desc', limit: a.limit, offset });
    const page = res.items;
    const total = res.total;
    const words = queryWords(query);
    const closest =
      query && !total && offset === 0 && words.length >= 2
        ? store.search({ ...bounded, text: query }, { sort: 'relevance', limit: a.limit, offset: 0, match: 'any' })
            .items
        : [];
    const next = offset + page.length < total ? offset + page.length : undefined;
    const nextCursor = next !== undefined ? encodeCursor({ k: 'sm', o: next, h, as_of: asOf }) : null;
    const threads =
      scope && scope.chatIds.length > 1 && scope.personId
        ? `all ${scope.chatIds.length} 1:1 threads with ${store.personName(scope.personId)}`
        : '';

    if (a.format === 'json') {
      const chats: Record<string, unknown> = {};
      for (const m of [...page, ...closest]) {
        if (chats[m.chatId]) continue;
        const c = store.chat(m.chatId)!;
        chats[m.chatId] = {
          title: store.chatTitle(c),
          type: c.type,
          participants: c.participantIds.slice(0, 10).map((id) => ({ person_id: id, name: store.personName(id) })),
          ...(c.participantIds.length > 10 ? { participants_omitted: c.participantIds.length - 10 } : {}),
        };
      }
      return jsonResult(
        {
          total,
          hits: page.map((m) => messageJson(store, m, renderOpts(ctx, 500))),
          chats,
          next_cursor: nextCursor,
          as_of: fmtIso(asOf, tz),
          ...(threads ? { chat_ids: scope!.chatIds } : {}),
          ...(closest.length
            ? { fallback: 'any_word', closest: closest.map((m) => messageJson(store, m, renderOpts(ctx, 500))) }
            : {}),
          ...(!total && query ? { search_note: NOT_IN_FILES } : {}),
        },
        { untrusted: true },
      );
    }
    if (!page.length) {
      if (offset > 0 && total) return textResult(`No more matches: all ${total} were on earlier pages.`);
      if (closest.length)
        return textResult(
          [
            `No message has all of: ${words.join(', ')}. Closest matches (some words or word roots):`,
            UNTRUSTED_NOTICE,
            ...hitLines(ctx, closest, a.context),
            NOT_IN_FILES,
          ].join('\n'),
        );
      const groups = scope?.personId
        ? ` That covered only your 1:1 threads; with="${scope.personId}" also searches group chats.`
        : '';
      return textResult(
        query
          ? `No messages match. Every word must appear: try one distinctive word or a shorter stem (booking → book), or drop a filter.${groups}\n${NOT_IN_FILES}`
          : `No messages match those filters. Drop a filter or widen the time range.${groups}`,
      );
    }
    const out = [
      `${plural(total, 'match', 'matches')} · showing ${offset + 1}–${offset + page.length} · sorted by ${sort}${threads ? ` · ${threads}` : ''}`,
      UNTRUSTED_NOTICE,
      ...hitLines(ctx, page, a.context),
    ];
    if (nextCursor) out.push(`more → cursor ${nextCursor}`);
    return textResult(out.join('\n'));
  },
});
