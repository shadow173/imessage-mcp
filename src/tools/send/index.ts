import { createDraft } from './createDraft.js';
import { manageDrafts } from './manageDrafts.js';
import { sendMessage } from './sendMessage.js';

/** In the order tools/list shows them; tools/catalog.ts lists the same names and tiers. */
export const SEND_TOOLS = [sendMessage, createDraft, manageDrafts];
