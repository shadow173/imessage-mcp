/**
 * Reads the message text out of chat.db's `attributedBody` (an NSAttributedString in NeXT typedstream form).
 * Validated against a real chat.db: the decoded text matched the `text` column on every row that has both.
 * Length tags: 0x81 = u16 LE, 0x82 = u32 LE, otherwise the byte itself is the length. This is an independent
 * implementation of those documented tags; ReagentX/crabstep (GPL-3.0) is a full typedstream parser.
 */
const NSSTRING = Buffer.from('NSString');

export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob || blob.length < 16) return null;
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  let i = b.indexOf(NSSTRING);
  if (i < 0) return null;
  i = b.indexOf(0x2b, i + NSSTRING.length); // '+' precedes the string payload
  if (i < 0 || i + 1 >= b.length) return null;
  i += 1;
  let len = b[i];
  if (len === 0x81) {
    if (i + 3 > b.length) return null;
    len = b.readUInt16LE(i + 1);
    i += 3;
  } else if (len === 0x82) {
    if (i + 5 > b.length) return null;
    len = b.readUInt32LE(i + 1);
    i += 5;
  } else if (len >= 0x83 && len <= 0x86)
    return null; // float / object / nil / end tags: not a length
  else i += 1;
  if (i + len > b.length) return null;
  return b.toString('utf8', i, i + len);
}

/** Removes the object-replacement characters Messages puts where attachments sit in the text. */
export function cleanText(s: string): string {
  return s.replace(/[￼�]/g, '').trim();
}
