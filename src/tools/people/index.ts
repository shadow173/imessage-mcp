import { getPerson } from './getPerson.js';
import { getStats } from './getStats.js';
import { getStatus } from './getStatus.js';

/** In the order tools/list shows them; tools/catalog.ts lists the same names and tiers. */
export const PEOPLE_TOOLS = [getPerson, getStats, getStatus];
