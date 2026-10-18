import * as z from 'zod/v4';
import { ATTACHMENT_KINDS, type AttachmentKind } from '../../domain/attachments.js';
import { checkCursorHash, cursorHash, encodeCursor, offsetCursor } from '../../lib/cursor.js';
import { UNTRUSTED_NOTICE } from '../../lib/format.js';
import { plural } from '../../lib/text.js';
import { fmtIso } from '../../lib/time.js';
import { type Chat, ME } from '../../store/types.js';
import { parseFrom } from '../args.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, textResult } from '../results.js';
import { zChatOpt, zCursor, zFormat, zFrom, zLimit, zList, zTime } from '../schemas.js';
import { mediaKit } from './common.js';

const KIND_ALIASES: Record<string, string> = {
  photo: 'image',
  photos: 'image',
  images: 'image',
  picture: 'image',
  pictures: 'image',
  pic: 'image',
  pics: 'image',
  screenshot: 'image',
  screenshots: 'image',
  videos: 'video',
  movie: 'video',
  movies: 'video',
  voicemail: 'voice_memo',
  voicemails: 'voice_memo',
  voice_memos: 'voice_memo',
  voice_message: 'voice_memo',
  voice_messages: 'voice_memo',
  audio_message: 'voice_memo',
  pdfs: 'pdf',
  documents: 'document',
  doc: 'document',
  docs: 'document',
  stickers: 'sticker',
};

const LaCursor = offsetCursor('la');

export const listAttachments = defineTool({
  name: 'list_attachments',
  tier: 'read',
  title: 'List attachments',
  description: [
    'Photos, videos, voice memos, PDFs and other files shared in messages, newest first.',
    'Filter by chat, sender, type, filename or date.',
    'Use get_attachment to open one.',
    'Rows show the text sent with each file, but only filenames are searched; search_messages with attachment_type matches the message text and shows each attachment_id.',
    'For what someone sent in any chat, set from to that person; chat set to a person covers only your 1:1 with them.',
  ].join(' '),
  inputSchema: {
    chat: zChatOpt,
    from: zFrom,
    type: zList(ATTACHMENT_KINDS, KIND_ALIASES)
      .optional()
      .describe(
        'One or more of: image (shown as "photo" in transcripts), video, audio, voice_memo, pdf, document, sticker.',
      ),
    name_query: z
      .string()
      .optional()
      .describe('Words in the filename only (not the message text). All must appear, in any order.'),
    after: zTime('On or after'),
    before: zTime('Before (exclusive)'),
    on: zTime('Only this day or month (excludes after/before)'),
    limit: zLimit(30, 100),
    cursor: zCursor,
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store, tz, titleOf, attLine, captionsFor, paging, frozenRange, showing, scopeOf, partnerElsewhere } =
      mediaKit(ctx);
    const { c, offset, asOf } = paging(a.cursor, LaCursor);
    const scope = scopeOf(a.chat, 'list_attachments');
    const chat = scope?.chat;
    const from = parseFrom(store, a.from);
    const kinds = a.type?.length ? ([...new Set(a.type)].sort() as AttachmentKind[]) : undefined;
    const nameQuery = a.name_query?.trim() || undefined;
    const h = cursorHash({
      chat: chat?.chatId,
      from,
      kinds,
      name: nameQuery,
      after: a.after,
      before: a.before,
      on: a.on,
    });
    if (c) checkCursorHash(c, h);
    const range = frozenRange(a, asOf);
    const { items: page, total } = store.listAttachments(
      { chatId: chat?.chatId, from, kinds, nameQuery, ...range },
      { limit: a.limit, offset },
    );
    const nextCursor =
      page.length && offset + page.length < total
        ? encodeCursor({ k: 'la', o: offset + page.length, h, as_of: asOf })
        : null;
    const caption = captionsFor(page);
    // The store filters one chat; a person's other 1:1 threads (email, SMS) are named rather than silently left out.
    const siblings = scope?.personId
      ? scope.chatIds
          .filter((id) => id !== chat!.chatId)
          .map((id) => store.chat(id))
          .filter((x): x is Chat => !!x)
      : [];
    const siblingNote = siblings.length
      ? `Other 1:1 threads with ${store.personName(scope!.personId!)} (not included): ${siblings.map((s) => `chat_id ${s.chatId} · ${s.service}`).join(', ')}`
      : undefined;

    const notes: string[] = [];
    let empty = '';
    if (!page.length) {
      const filtered = !!(from || kinds || nameQuery || a.after || a.before || a.on);
      if (chat?.type === 'dm' && offset === 0) {
        const pid = chat.participantIds[0];
        const name = store.personName(pid);
        empty = `No ${filtered ? 'matching ' : ''}attachments in your 1:1 chat with ${name}.`;
        if (partnerElsewhere(from, pid)) {
          const n = store.listAttachments(
            { from: { kind: 'person', personId: pid }, kinds, nameQuery, ...range },
            { limit: 1, offset: 0 },
          ).total;
          if (n)
            notes.push(
              `${name} sent ${plural(n, 'matching attachment')} in other chats: call list_attachments again with from="${pid}" and no chat.`,
            );
        }
      } else
        empty = chat
          ? `No ${filtered ? 'matching ' : ''}attachments in ${store.chatTitle(chat)}.`
          : 'No attachments match.';
      if (nameQuery)
        notes.push(
          'name_query matches filenames only (photos are usually IMG_####); to match what the message said, use search_messages with query and attachment_type.',
        );
    }

    if (a.format === 'json') {
      const attachments = page.map((x) => {
        const cap = caption(x);
        return {
          attachment_id: x.attachmentId,
          name: x.name,
          kind: x.kind,
          mime: x.mime,
          bytes: x.bytes,
          on_device: x.onDevice ?? true,
          width: x.width,
          height: x.height,
          duration_s: x.durationS,
          sent_at: fmtIso(x.sentAt, tz),
          from: x.senderId === ME ? 'me' : store.personName(x.senderId),
          chat_id: x.chatId,
          chat_title: titleOf(store.chat(x.chatId)),
          message_id: x.messageId,
          ...(cap ? { caption: cap } : {}),
        };
      });
      const extra = {
        ...(siblings.length ? { other_dm_chat_ids: siblings.map((s) => s.chatId) } : {}),
        ...(notes.length ? { hint: notes.join(' ') } : {}),
      };
      return jsonResult({ total, attachments, next_cursor: nextCursor, ...extra }, { untrusted: page.length > 0 });
    }
    if (!page.length) return textResult([empty, ...notes, ...(siblingNote ? [siblingNote] : [])].join('\n'));
    const out = [
      showing(total, offset, page.length, 'attachment'),
      UNTRUSTED_NOTICE,
      ...page.map((x) => attLine(x, caption(x))),
    ];
    if (siblingNote) out.push(siblingNote);
    if (nextCursor) out.push(`more → cursor ${nextCursor}`);
    return textResult(out.join('\n'));
  },
});
