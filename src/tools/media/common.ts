// What the attachment and link tools share: kind groups, the download-link size limit, and mediaKit.

import type * as z from 'zod/v4';
import type { AttachmentKind } from '../../domain/attachments.js';
import { decodeCursor, type OffsetCursor } from '../../lib/cursor.js';
import { ToolError } from '../../lib/errors.js';
import { attachmentFacts, fmtBytes, messageText } from '../../lib/format.js';
import { resolveChatScope, resolvePerson } from '../../lib/resolve.js';
import { oneLine, plural } from '../../lib/text.js';
import { fmtShort, resolveRange, type TimeRange } from '../../lib/time.js';
import { MAX_FILE_BYTES } from '../../relay/protocol.js';
import { type Attachment, type Chat, type FromFilter, ME } from '../../store/types.js';
import { normalizeAttachmentId, normalizeMessageId } from '../args.js';
import type { Ctx } from '../context.js';

export const AUDIO = new Set<AttachmentKind>(['voice_memo', 'audio']);
export const READABLE = new Set<AttachmentKind>(['pdf', 'document', 'image', 'sticker']);
const ID_FIX =
  'Use list_attachments or get_message to find attachment ids. Attachment ids look like a104 and appear in transcripts as [photo NAME · a104].';

export const isHeic = (a: Attachment) => /hei[cf]/i.test(a.mime) || /\.hei[cf]$/i.test(a.name);

/** HEIC is served as a converted (smaller) JPEG, so only other files hit the relay's frame limit. */
export const tooBigForLink = (a: Attachment) => a.bytes > MAX_FILE_BYTES && !isHeic(a);

/** Helpers the media tools share, bound to one request's context. */
export function mediaKit(ctx: Ctx) {
  const { store } = ctx;
  const tz = store.timeZone;

  const titleOf = (c: Chat | undefined) => (c ? store.chatTitle(c) : 'an unknown chat');
  /** "from Jo Kim · 1:1", "from You to Jo Kim · 1:1", or "from Jo Kim in Cabin Weekend". */
  const origin = (verb: string, senderId: string, chatId: string) => {
    const c = store.chat(chatId);
    if (c?.type === 'dm')
      return senderId === ME
        ? `${verb} You to ${store.chatTitle(c)} · 1:1`
        : `${verb} ${store.personName(senderId)} · 1:1`;
    return `${verb} ${senderId === ME ? 'You' : store.personName(senderId)} in ${titleOf(c)}`;
  };
  const attLine = (a: Attachment, caption?: string) =>
    `• ${attachmentFacts(a)} · ${origin('from', a.senderId, a.chatId)} · ${fmtShort(a.sentAt, tz, store.now())}${caption ? ` · "${caption}"` : ''}\n  attachment_id ${a.attachmentId} · message_id ${a.messageId} · chat_id ${a.chatId}`;

  /** The text sent with each file (redacted, 80 chars), one message lookup per message. */
  const captionsFor = (page: Attachment[]) => {
    const byMsg = new Map<string, string | undefined>();
    for (const a of page) {
      if (byMsg.has(a.messageId)) continue;
      const m = store.message(a.messageId);
      const t =
        m && !m.unsent
          ? oneLine(
              messageText(store, m, { redactCodes: ctx.cfg.redactCodes, maxChars: 80, moreHint: false }).replace(
                /\uFFFC/g,
                '',
              ),
            ).trim()
          : '';
      byMsg.set(a.messageId, t || undefined);
    }
    return (a: Attachment) => byMsg.get(a.messageId);
  };

  /**
   * Offset paging frozen at the first page's time: the range resolves against as_of and stops at it, so new items can't
   * shift later pages.
   */
  const paging = <C extends OffsetCursor>(cursor: string | undefined, schema: z.ZodType<C>) => {
    const c = cursor ? decodeCursor(cursor, schema) : undefined;
    return { c, offset: c?.o ?? 0, asOf: c?.as_of ?? store.now() };
  };
  const frozenRange = (a: { after?: string; before?: string; on?: string }, asOf: number): TimeRange => {
    const r = resolveRange({ after: a.after, before: a.before, on: a.on }, tz, asOf);
    return { after: r.after, before: Math.min(r.before ?? Infinity, asOf + 1) };
  };
  /** "6 attachments", or "40 attachments · showing 31–40" once there is more than one page. */
  const showing = (total: number, offset: number, n: number, word: string) =>
    offset || n < total ? `${plural(total, word)} · showing ${offset + 1}–${offset + n}` : plural(total, word);
  /** chat=<person> with no 1:1 thread: point at from, which covers their group-chat messages. */
  const scopeOf = (input: string | undefined, tool: string) => {
    if (!input) return undefined;
    try {
      return resolveChatScope(store, input);
    } catch (e) {
      if (e instanceof ToolError && e.code === 'no_conversation') {
        let p: string | undefined;
        try {
          p = resolvePerson(store, input).personId;
        } catch {
          /* not a person */
        }
        if (p)
          e.fix = `To list what ${store.personName(p)} shared in group chats, call ${tool} with from="${p}" and no chat.`;
      }
      throw e;
    }
  };
  /** An empty 1:1 page may only mean their files are in group chats. */
  const partnerElsewhere = (from: FromFilter | undefined, pid: string) =>
    !from || from.kind === 'others' || (from.kind === 'person' && from.personId === pid);

  /** An attachment id, a transcript tag, "#a104"/"att:a104", or a message id whose message holds exactly one file. */
  const openAttachment = (raw: string): Attachment => {
    const input = raw.trim();
    let id = normalizeAttachmentId(input);
    id = id.match(/·\s*(a\d+)\]?$/i)?.[1] ?? id;
    // A bare number means a<n> only: guessing m<n> could open an unrelated file in live, where ids are chat.db ROWIDs.
    if (/^A?\d+$/.test(id)) id = `a${id.replace(/^A/, '')}`;
    const att = store.attachment(id);
    if (att) return att;
    const m = /^a\d+$/.test(id) ? undefined : store.message(normalizeMessageId(input));
    if (m) {
      const ids = m.attachmentIds.filter((x) => store.attachment(x));
      if (ids.length === 1) return store.attachment(ids[0])!;
      if (ids.length > 1)
        throw new ToolError(
          'attachment_not_found',
          `"${input}" is a message with ${ids.length} attachments, not an attachment id.`,
          `Pass one of these attachment_ids: ${ids.map((x) => `${x} · ${store.attachment(x)!.name}`).join(', ')}.`,
        );
      throw new ToolError('attachment_not_found', `"${input}" is a message with no attachments.`, ID_FIX);
    }
    if (/\.[a-z0-9]{2,5}$/i.test(id))
      throw new ToolError(
        'attachment_not_found',
        `"${input}" looks like a filename, not an attachment id.`,
        `Use list_attachments with name_query="${input}" to get its attachment_id.`,
      );
    throw new ToolError('attachment_not_found', `No attachment has id "${input}".`, ID_FIX);
  };

  const noPreview = (att: Attachment) => {
    const audio = AUDIO.has(att.kind);
    const readable = (audio && !!att.extractedText) || READABLE.has(att.kind);
    const head = audio ? 'No preview for audio.' : `No preview for this ${att.kind === 'video' ? 'video' : 'file'}.`;
    if (tooBigForLink(att))
      return `${head} It is ${fmtBytes(att.bytes)}, too large for a download link.\nFix: ${readable && !audio ? 'Use mode=text to read it, or tell' : 'Tell'} the user to open it in Messages on the Mac.`;
    return `${head} ${readable ? `Use mode=text${audio ? '' : ' to read it'}, or mode=link` : 'Use mode=link'} to give the user a ${audio || att.kind === 'video' ? 'playable' : 'download'} link.`;
  };
  return {
    store,
    tz,
    titleOf,
    origin,
    attLine,
    captionsFor,
    paging,
    frozenRange,
    showing,
    scopeOf,
    partnerElsewhere,
    openAttachment,
    noPreview,
  };
}
