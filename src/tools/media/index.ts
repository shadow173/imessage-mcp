import { getAttachment } from './getAttachment.js';
import { listAttachments } from './listAttachments.js';
import { listLinks } from './listLinks.js';

/** In the order tools/list shows them; tools/catalog.ts lists the same names and tiers. */
export const MEDIA_TOOLS = [listAttachments, getAttachment, listLinks];
