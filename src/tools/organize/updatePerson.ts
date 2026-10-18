import * as z from 'zod/v4';
import { type Candidate, ToolError } from '../../lib/errors.js';
import { dmChatFor, matchPeople, personCandidate, resolvePerson } from '../../lib/resolve.js';
import { defineTool, LOCAL_WRITE } from '../registry.js';
import { jsonResult } from '../results.js';

const joinNames = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? '');

export const updatePerson = defineTool({
  name: 'update_person',
  tier: 'org',
  title: 'Save aliases and notes for a person',
  description: [
    'Save what the owner tells you about a person: aliases they use such as "my landlord" or "Mom", a note, or labels.',
    'Contacts is not changed.',
    'Aliases make every tool resolve the person by that phrase; notes and labels show in find, search_people and get_person, and search_people matches labels.',
    'To tell two people with the same name apart, save an alias such as "climbing gym Sam".',
    'Saved aliases match with or without a leading my/our/the.',
    'An alias that already matches someone else needs user_confirmed.',
  ].join(' '),
  inputSchema: {
    person: z
      .string()
      .describe(
        'Name, alias, phone, email or person_id. It must match one person; pass the person_id when names collide.',
      ),
    add_aliases: z.array(z.string()).optional(),
    remove_aliases: z.array(z.string()).optional(),
    note: z.string().optional().describe('Replaces the current note. Empty string clears it.'),
    add_labels: z.array(z.string()).optional(),
    remove_labels: z.array(z.string()).optional(),
    user_confirmed: z
      .boolean()
      .optional()
      .describe('Save an alias that already matches someone else, after the user approved it.'),
  },
  annotations: LOCAL_WRITE,
  handler: (a, ctx) => {
    const { store } = ctx;
    const p = resolvePerson(store, a.person, { strict: true });
    const who = store.personName(p.personId);
    // An alias that also names someone else redirects every tool to this person, even when it names them too ("Sam"
    // for one of two Sams).
    const conflicts: { alias: string; others: string[] }[] = [];
    const candidates = new Map<string, Candidate>();
    for (const alias of (a.add_aliases ?? []).map((x) => x.trim()).filter(Boolean)) {
      const hits = matchPeople(store, alias);
      const others = hits.filter((h) => h.item.personId !== p.personId && h.score >= 2);
      if (!others.length) continue;
      conflicts.push({ alias, others: others.map((h) => store.personName(h.item.personId)) });
      for (const h of others)
        if (!candidates.has(h.item.personId)) candidates.set(h.item.personId, personCandidate(store, h.item));
    }
    if (conflicts.length && !a.user_confirmed) {
      throw new ToolError(
        'alias_conflict',
        `${conflicts.map((c) => `"${c.alias}" already matches ${joinNames(c.others)}. Saving it for ${who} would make "${c.alias}" mean ${who} in every tool, including send_message.`).join(' ')} Nothing was saved.`,
        `Ask the user whether that is what they want, then call again with user_confirmed=true, or pick a more specific alias ("${conflicts[0].alias} from climbing").`,
        [...candidates.values()].slice(0, 8),
      );
    }
    const u = store.updatePerson(p.personId, {
      addAliases: a.add_aliases,
      removeAliases: a.remove_aliases,
      note: a.note,
      addLabels: a.add_labels,
      removeLabels: a.remove_labels,
    });
    return jsonResult({
      person_id: u.personId,
      name: store.personName(u.personId),
      in_contacts: u.name !== null,
      ...(u.nicknames.length ? { nicknames: u.nicknames } : {}),
      aliases: u.aliases,
      note: u.note ?? null,
      labels: u.labels,
      dm_chat_id: dmChatFor(store, u.personId)?.chatId ?? null,
      ...(conflicts.length
        ? {
            warning: conflicts
              .map((c) => `"${c.alias}" also matches ${joinNames(c.others)}; pass a person_id when you mean them.`)
              .join(' '),
          }
        : {}),
    });
  },
});
