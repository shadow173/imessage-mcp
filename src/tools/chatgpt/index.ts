import { fetch } from './fetch.js';
import { search } from './search.js';

/** In the order tools/list shows them; tools/catalog.ts lists the same names and tiers. */
export const CHATGPT_TOOLS = [search, fetch];
