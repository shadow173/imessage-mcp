import { labelConversation } from './labelConversation.js';
import { setReminder } from './setReminder.js';
import { updatePerson } from './updatePerson.js';

/** In the order tools/list shows them; tools/catalog.ts lists the same names and tiers. */
export const ORGANIZE_TOOLS = [updatePerson, labelConversation, setReminder];
