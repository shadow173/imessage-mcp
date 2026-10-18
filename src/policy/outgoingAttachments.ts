// Checks on files the agent sends, in the tool layer so mock and live reject the same input before anything is sent.

import { ToolError } from '../lib/errors.js';
import { checkPublicHttpsUrl } from '../lib/net.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isImageBytes(b: Buffer): boolean {
  const at = (o: number, s: string) => b.subarray(o, o + s.length).toString('latin1') === s;
  return (
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
    b.subarray(0, 8).equals(PNG_SIG) ||
    at(0, 'GIF8') ||
    (at(0, 'RIFF') && at(8, 'WEBP')) ||
    at(4, 'ftyp') ||
    at(0, 'II*\0') ||
    at(0, 'MM\0*') ||
    at(0, 'BM')
  );
}

/**
 * Validates and canonicalizes attachment base64: strips a data: prefix and whitespace, accepts base64url, rejects
 * non-base64, and checks image (any image signature) and PDF headers. Throws invalid_attachment.
 */
export function cleanAttachmentBase64(filename: string, mime: string, raw: string): string {
  const m = mime.trim().toLowerCase();
  const image = m.startsWith('image/') && !/svg|icon/.test(m);
  const pdf = m === 'application/pdf';
  const fail = (reason: string) =>
    new ToolError(
      'invalid_attachment',
      `${filename} isn't a valid ${image ? 'image' : pdf ? 'PDF' : m || 'base64'} file (${reason}). Nothing was sent.`,
      'To forward a file that is already in Messages, pass its attachment_id. Never retype or rebuild a file you only saw as a preview or extracted text.',
    );
  const s = raw
    .trim()
    .replace(/^data:[^,]*;base64,/i, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  if (!s) throw fail('empty');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw fail('not base64');
  if (s.length % 4 === 1) throw fail('truncated base64');
  const b = Buffer.from(s, 'base64');
  if (b.toString('base64').replace(/=+$/, '') !== s.replace(/=+$/, '')) throw fail('not base64');
  if ((image || pdf) && b.length < 32) throw fail(`only ${b.length} bytes`);
  if (image && !isImageBytes(b)) throw fail('the bytes are not a JPEG, PNG, GIF, WebP, HEIC, TIFF or BMP image');
  if (pdf && !b.subarray(0, 1024).includes('%PDF-')) throw fail('no %PDF- header');
  return b.toString('base64');
}

/** cleanAttachmentBase64 for a group photo: any real image, code invalid_image. */
export function cleanImageBase64(label: string, raw: string): string {
  try {
    return cleanAttachmentBase64(label, 'image/*', raw);
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    throw new ToolError(
      'invalid_image',
      e.message.replace('Nothing was sent.', 'Nothing was changed.'),
      'Pass the base64 bytes of a real JPEG, PNG, GIF, WebP or HEIC file. Never retype or rebuild an image you only saw as a preview.',
    );
  }
}

/**
 * Attachment URLs: public https only (or this server's own signed links). DNS and redirects are checked again where the
 * file is fetched.
 */
export function checkAttachmentUrl(ctx: { baseUrl: string }, filename: string, url: string): string {
  const blocked = () =>
    new ToolError(
      'attachment_url_blocked',
      `${filename}: only public https URLs can be attached.`,
      'Pass attachment_id for a file already in Messages, or base64.',
    );
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw blocked();
  }
  if (u.username || u.password) throw blocked();
  let own: string | undefined;
  try {
    own = new URL(ctx.baseUrl).origin;
  } catch {
    /* no public origin configured */
  }
  if (own && u.origin === own) return u.href;
  if (checkPublicHttpsUrl(u)) throw blocked();
  return u.href;
}
