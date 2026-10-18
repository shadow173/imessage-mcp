// Files on send_message and drafts: the argument schema, and validation before any policy check or send.

import * as z from 'zod/v4';
import { ToolError } from '../../lib/errors.js';
import { checkAttachmentUrl, cleanAttachmentBase64 } from '../../policy/outgoingAttachments.js';
import type { OutgoingAttachment } from '../../store/types.js';
import { normalizeAttachmentId } from '../args.js';
import type { Ctx } from '../context.js';

const MAX_BASE64_CHARS = 14_000_000;

export const zAttachment = z.object({
  attachment_id: z
    .string()
    .optional()
    .describe(
      'Forward a file already in Messages (id from list_attachments, get_message or a transcript). filename and mime_type come from the original.',
    ),
  filename: z.string().optional().describe('Required with base64 or url.'),
  mime_type: z.string().optional().describe('e.g. image/png, application/pdf. Required with base64 or url.'),
  base64: z
    .string()
    .optional()
    .describe('File bytes, base64 (a data: prefix is fine). Up to about 10 MB. Only bytes you actually have.'),
  url: z.string().optional().describe('Public https URL the Mac downloads.'),
});
type AttachmentArg = z.infer<typeof zAttachment>;

/**
 * Validates every file before policy or sending, so a bad file never costs a confirmation round trip or a key.
 * forDraft: drafts keep no bytes, so base64 and our own expiring /files/ links are refused there.
 */
export function prepareAttachments(ctx: Ctx, list: AttachmentArg[], forDraft = false): OutgoingAttachment[] {
  const { store } = ctx;
  let own: string | undefined;
  try {
    own = new URL(ctx.baseUrl).origin;
  } catch {
    /* no public origin */
  }
  return list.map((x, i) => {
    if (x.attachment_id) {
      const src = store.attachment(normalizeAttachmentId(x.attachment_id));
      if (!src)
        throw new ToolError(
          'attachment_not_found',
          `No attachment has id "${x.attachment_id}".`,
          'Use list_attachments or get_message to find attachment ids.',
        );
      if (src.onDevice === false)
        throw new ToolError(
          'attachment_not_downloaded',
          `${src.name} is in iCloud, not on this Mac, so it can't be forwarded. Nothing was sent.`,
          'Tell the user. Opening the conversation in Messages on the Mac downloads it; then try again.',
        );
      return { filename: src.name, mime: src.mime, sourceAttachmentId: src.attachmentId };
    }
    const label = x.filename || `attachments[${i}]`;
    if (!x.base64 && !x.url)
      throw new ToolError(
        'invalid_attachment',
        `${label} needs attachment_id, base64 or url.`,
        'To forward a file already in Messages, pass its attachment_id; otherwise pass base64 or a public https url, with filename and mime_type.',
      );
    if (!x.filename || !x.mime_type)
      throw new ToolError(
        'invalid_attachment',
        `${label} needs filename and mime_type with ${x.base64 ? 'base64' : 'url'}.`,
        'Pass both, e.g. filename "photo.jpg" and mime_type "image/jpeg", or forward a file already in Messages with attachment_id.',
      );
    if (forDraft && x.base64)
      throw new ToolError(
        'attachments_not_supported',
        "Drafts can't hold raw file bytes. Nothing was saved.",
        'Pass attachment_id for a file already in Messages, or a public https url; or send the file with send_message.',
      );
    if (x.base64) {
      const base64 = cleanAttachmentBase64(x.filename, x.mime_type, x.base64);
      if (base64.length > MAX_BASE64_CHARS)
        throw new ToolError(
          'attachment_too_large',
          `${x.filename} is over 10 MB. Nothing was sent.`,
          'Pass a public https url instead, or forward a file already in Messages with attachment_id.',
        );
      return { filename: x.filename, mime: x.mime_type, base64 };
    }
    const url = checkAttachmentUrl(ctx, x.filename, x.url!);
    if (forDraft && own && new URL(url).origin === own) {
      const id = new URL(url).pathname.match(/^\/files\/([^/]+)/)?.[1];
      throw new ToolError(
        'attachments_not_supported',
        `That link to ${x.filename} expires, so a draft can't keep it. Nothing was saved.`,
        `Pass attachment_id${id ? ` "${decodeURIComponent(id)}"` : ''} instead.`,
      );
    }
    return { filename: x.filename, mime: x.mime_type, url };
  });
}
