import { editMessage } from './editMessage.js';
import { manageGroup } from './manageGroup.js';
import { markRead } from './markRead.js';
import { react } from './react.js';
import { setTyping } from './setTyping.js';
import { unsendMessage } from './unsendMessage.js';

/** In the order tools/list shows them; tools/catalog.ts lists the same names and tiers. */
export const PRIVATE_API_TOOLS = [react, editMessage, unsendMessage, markRead, setTyping, manageGroup];
