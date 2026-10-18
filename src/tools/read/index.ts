import { catchUp } from './catchUp.js';
import { getConversation } from './getConversation.js';
import { getMessage } from './getMessage.js';
import { getReplyThread } from './getReplyThread.js';
import { getUpdates } from './getUpdates.js';
import { readConversation } from './readConversation.js';

/** In the order tools/list shows them; tools/catalog.ts lists the same names and tiers. */
export const READ_TOOLS = [readConversation, getConversation, getMessage, getReplyThread, catchUp, getUpdates];
