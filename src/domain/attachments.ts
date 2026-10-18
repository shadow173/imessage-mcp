/** What an attachment is, as the store classifies it and the tools filter by it. */
export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'voice_memo', 'pdf', 'document', 'sticker'] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * The kind with spaces, as attachment details list it.
 * @example kindName('voice_memo') // 'voice memo'
 */
export const kindName = (kind: AttachmentKind) => kind.replace('_', ' ');

/**
 * The word transcripts use for an attachment: an image is a photo.
 * @example kindLabel('image') // 'photo'
 * @example kindLabel('voice_memo') // 'voice memo'
 */
export const kindLabel = (kind: AttachmentKind) => (kind === 'image' ? 'photo' : kindName(kind));
