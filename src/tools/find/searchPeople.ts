import * as z from 'zod/v4';
import { isPhoneShaped, isShortCode, normalizeAddress, prettyAddress } from '../../lib/address.js';
import { UNTRUSTED_NOTICE } from '../../lib/format.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, textResult } from '../results.js';
import { zFormat, zLimit } from '../schemas.js';
import { peopleMatching, personLine, personSummary } from './common.js';

export const searchPeople = defineTool({
  name: 'search_people',
  tier: 'read',
  title: 'Search people',
  description: [
    'Find people by name, nickname, saved alias, company, label, or a phone or email fragment (a full number, its last 4+ digits, or part of an email).',
    "Each result includes the person's 1:1 chat_id, the last message each way, and whether they're waiting on your reply.",
    "Numbers that aren't in Contacts are included unless include_unknown is false.",
  ].join(' '),
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe('Name, nickname, alias, company, label, phone or email. Prefix a word with "-" to exclude it.'),
    include_unknown: z.boolean().default(true).describe('Include numbers with no Contacts card.'),
    limit: zLimit(10, 50),
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: ({ query, include_unknown, limit, format }, ctx) => {
    const { store } = ctx;
    const words = query.trim().split(/\s+/);
    const isExclusion = (w: string) => w.startsWith('-') && w.length > 1 && !isPhoneShaped(w);
    const exclude = words.filter(isExclusion).map((w) => w.slice(1).toLowerCase());
    const q = words.filter((w) => !isExclusion(w)).join(' ') || query.trim();
    let people = peopleMatching(store, q);
    if (exclude.length)
      people = people.filter(
        (p) =>
          !exclude.some((x) =>
            [p.name ?? '', ...p.nicknames, ...p.aliases, p.company ?? '', ...p.labels, p.note ?? '']
              .join(' ')
              .toLowerCase()
              .includes(x),
          ),
      );
    if (!include_unknown) people = people.filter((p) => p.name !== null);
    people = people.slice(0, limit);
    const sums = people.map((p) => personSummary(ctx, p));
    if (format === 'json') return jsonResult({ people: sums }, { untrusted: true });
    if (!people.length) {
      const addr = normalizeAddress(q);
      if (addr)
        return textResult(
          `No contact or conversation uses ${prettyAddress(addr)}${isShortCode(addr) ? ' or a number ending in it' : ''}.`,
        );
      if (isPhoneShaped(q) || q.includes('@'))
        return textResult(`No contact or conversation has a number or email containing "${q}".`);
      return textResult(
        `No people match "${query}". Try a shorter name, a nickname, or find with words from their messages.`,
      );
    }
    const lines = people.map((p, i) => personLine(ctx, p, sums[i]));
    return textResult((sums.some((s) => s.last_interaction) ? [UNTRUSTED_NOTICE, ...lines] : lines).join('\n'));
  },
});
