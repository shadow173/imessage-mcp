import * as z from 'zod/v4';
import { ToolError } from '../../lib/errors.js';
import { chatJson, chatLine, messageJson, UNTRUSTED_NOTICE } from '../../lib/format.js';
import { matchPeople, titleMatches } from '../../lib/resolve.js';
import type { MessageStore } from '../../store/ports.js';
import type { ChatSummary, Message, MessageFilter, Person } from '../../store/types.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, renderOpts, textResult } from '../results.js';
import { zFormat } from '../schemas.js';
import {
  convoMatch,
  hitLines,
  NOT_IN_FILES,
  peopleMatching,
  personLine,
  personSummary,
  queryWords,
  withFormerly,
} from './common.js';

// Linking words and request phrasing ("the link Sam sent about the cabin" -> "cabin"); never searched as the topic.
const TOPIC_STOP = new Set([
  'from',
  'with',
  'about',
  'to',
  'and',
  'the',
  're',
  'regarding',
  'a',
  'an',
  'my',
  'that',
  'sent',
  'send',
  'sends',
  'said',
  'say',
  'says',
  'tell',
  'tells',
  'told',
  'mention',
  'mentions',
  'mentioned',
  'talk',
  'talked',
  'ask',
  'asked',
  'message',
  'messages',
  'messaged',
  'text',
  'texts',
  'texted',
  'link',
  'links',
  'shared',
  'share',
  'what',
  'when',
  'where',
  'who',
  'why',
  'how',
  'which',
  'did',
  'does',
  'do',
  'is',
  'was',
  'me',
  'us',
  'anything',
  'something',
  'last',
  'of',
  'for',
  'on',
]);

/**
 * "Sam cabin" -> "Sam" + "cabin": the longest (then leftmost) run of words that names someone at score >= 2
 * (never a score-1 fragment like "car" -> Carter); the rest, minus linking words, is the topic.
 */
function splitNameTopic(
  store: MessageStore,
  query: string,
): { name: string; people: Person[]; rest: string } | undefined {
  const words = query
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/['’]s$/i, ''));
  for (let len = words.length - 1; len >= 1; len--) {
    for (let at = 0; at + len <= words.length; at++) {
      const name = words.slice(at, at + len).join(' ');
      const hits = matchPeople(store, name).filter((h) => h.score >= 2);
      if (!hits.length) continue;
      const rest = [...words.slice(0, at), ...words.slice(at + len)]
        .filter((w) => !TOPIC_STOP.has(w.toLowerCase()))
        .join(' ');
      if (!rest) return undefined;
      return {
        name,
        people: hits
          .filter((h) => h.score === hits[0].score)
          .slice(0, 3)
          .map((h) => h.item),
        rest,
      };
    }
  }
  return undefined;
}

export const find = defineTool({
  name: 'find',
  tier: 'read',
  title: 'Find people, chats and messages',
  description: [
    'Broad lookup across people, conversations and message text in one call.',
    "Use it for topics, unfamiliar names, or when you aren't sure which tool fits.",
    'If you already know the person or chat, call that tool directly.',
    'Returns matching people, conversations (by title, former title, participant or label) and the best-matching messages (for the latest, use search_messages with sort=newest).',
    'Words match by spelling, not meaning; a word of 3+ letters also matches longer words that start with it.',
    'A name plus topic words ("Sam cabin") is read as that topic in conversations with that person.',
    'If several people fit a name, ask the user which one before acting.',
  ].join(' '),
  inputSchema: {
    query: z.string().min(1).describe('A name, alias, phone, email, group name, label, or words from messages.'),
    limit_per_section: z.number().int().min(1).max(20).default(5).describe('Default 5, max 20.'),
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: ({ query, limit_per_section: lim, format }, ctx) => {
    const { store } = ctx;
    const q = query.trim();
    const opts = renderOpts(ctx);
    let people = peopleMatching(store, q).slice(0, lim);
    const peopleIds = new Set(people.map((p) => p.personId));
    const recent = (x: ChatSummary, y: ChatSummary) => (y.lastMessage?.sentAt ?? 0) - (x.lastMessage?.sentAt ?? 0);
    let convos = store
      .chatSummaries()
      .filter((s) => s.lastMessage)
      .map((s) => ({ s, m: convoMatch(s, q, peopleIds) }))
      .filter((x): x is { s: ChatSummary; m: { formerly?: string } } => !!x.m)
      .sort((x, y) => recent(x.s, y.s))
      .slice(0, lim);

    let searchNote = '';
    const search = (f: MessageFilter & { text: string }, limit: number, match?: 'any') => {
      try {
        return store.search(f, { sort: 'relevance', limit, offset: 0, ...(match ? { match } : {}) });
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        searchNote = e.fix ? `${e.message} ${e.fix}` : e.message;
        return { items: [] as Message[], total: 0 };
      }
    };
    // A name query over-fetches, then puts messages involving the matched people first (relevance order kept within
    // each group).
    const involves = (m: Message) =>
      peopleIds.has(m.senderId) || (store.chat(m.chatId)?.participantIds.some((id) => peopleIds.has(id)) ?? false);
    const res = search({ text: q }, people.length ? Math.min(50, lim * 4) : lim);
    let hits = people.length
      ? [...res.items.filter(involves), ...res.items.filter((m) => !involves(m))].slice(0, lim)
      : res.items;
    const words = queryWords(q);

    // Nothing matched the whole query: try it as a name plus a topic, then as any of its words.
    let split: ReturnType<typeof splitNameTopic>;
    let interpreted:
      | {
          name: string;
          rest: string;
          groups: { person: Person; hits: Message[]; total: number }[];
          anyWord?: boolean;
        }
      | undefined;
    let closest: Message[] = [];
    if (!searchNote && !people.length && !convos.length && !hits.length && words.length >= 2) {
      split = splitNameTopic(store, q);
      if (split) {
        const sp = split;
        const byPerson = (match?: 'any') =>
          sp.people
            .map((person) => {
              const r = search({ text: sp.rest, withPersonId: person.personId }, lim, match);
              return { person, hits: r.items, total: r.total };
            })
            .sort((x, y) => y.total - x.total);
        let groups = byPerson();
        let anyWord = false;
        // Every topic word must match; when that finds nothing, any of them inside that person's conversations.
        if (!groups.some((g) => g.total > 0) && sp.rest.split(/\s+/).length > 1) {
          groups = byPerson('any');
          anyWord = true;
        }
        if (groups.some((g) => g.total > 0)) {
          interpreted = { name: sp.name, rest: sp.rest, groups, anyWord };
          people = groups.map((g) => g.person);
          const ids = new Set(people.map((p) => p.personId));
          const topical = (s: ChatSummary) => (titleMatches(s.title, sp.rest) ? 0 : 1);
          convos = store
            .chatSummaries()
            .filter((s) => s.lastMessage && s.chat.participantIds.some((id) => ids.has(id)))
            .sort((x, y) => topical(x) - topical(y) || recent(x, y))
            .slice(0, lim)
            .map((s) => ({ s, m: {} }));
          const seen = new Set<string>();
          hits = groups.flatMap((g) => g.hits).filter((m) => !seen.has(m.messageId) && !!seen.add(m.messageId));
        }
      } else closest = search({ text: q }, lim, 'any').items;
    }

    const nothing = !people.length && !convos.length && !hits.length;
    const names = split?.people.map((p) => store.personName(p.personId)).join(' or ');
    const hint =
      !nothing || words.length < 2
        ? ''
        : split
          ? `No match for the whole query, and no "${split.rest}" in conversations with ${names}. Try another word or a shorter stem: search_messages(query:"…", with:"${split.people[0].personId}"). For a shared link: list_links(query:"${split.rest}").`
          : 'No match for the whole query. For a person plus a topic, try search_messages(query:"<topic>", with:"<name>"). For a shared link: list_links(query:"<topic>").';
    const filesNote = !hits.length && !searchNote && !people.length ? NOT_IN_FILES : ''; // a topic, not a name or number
    const labels = !convos.length ? store.labelCounts() : [];
    const first = people[0];
    const hitJson = (m: Message) => ({
      ...messageJson(store, m, renderOpts(ctx, 300)),
      chat_title: store.chatTitle(store.chat(m.chatId)!),
    });

    if (format === 'json') {
      return jsonResult(
        {
          people: people.map((p) => personSummary(ctx, p)),
          conversations: convos.map(({ s, m }) => ({
            ...chatJson(store, s, opts),
            ...(m.formerly ? { formerly: m.formerly } : {}),
          })),
          messages: hits.map(hitJson),
          ...(interpreted
            ? {
                interpreted_as: {
                  name: interpreted.name,
                  text: interpreted.rest,
                  person_ids: interpreted.groups.map((g) => g.person.personId),
                  ...(interpreted.anyWord ? { match: 'any_word' } : {}),
                },
              }
            : {}),
          ...(closest.length ? { fallback: 'any_word', closest: closest.map(hitJson) } : {}),
          ...(searchNote || filesNote ? { search_note: searchNote || filesNote } : {}),
          ...(labels.length ? { labels } : {}),
          ...(hint ? { hint } : {}),
          more: `For more: search_people, list_conversations(query), search_messages(query).${first ? ` For what ${store.personName(first.personId)} sent: search_messages(from="${first.personId}").` : ''}`,
        },
        { untrusted: true },
      );
    }

    const out: string[] = [];
    if (!nothing || closest.length) out.push(UNTRUSTED_NOTICE);
    out.push(`People (${people.length})`, ...(people.length ? people.map((p) => personLine(ctx, p)) : ['  none']));
    out.push(
      '',
      `Conversations (${convos.length})`,
      ...(convos.length ? convos.map(({ s, m }) => chatLine(store, withFormerly(s, m.formerly), opts)) : ['  none']),
    );
    out.push('');
    if (interpreted) {
      const counts = interpreted.groups.map((g) => `${store.personName(g.person.personId)} (${g.total})`).join(' / ');
      out.push(
        `Messages: no match for "${q}" as typed. Interpreted as ${interpreted.anyWord ? `any of the words "${interpreted.rest}"` : `"${interpreted.rest}"`} in conversations with ${counts}.`,
      );
      let n = 1;
      const shown = new Set<string>();
      for (const g of interpreted.groups) {
        if (!g.hits.length) continue;
        const fresh = g.hits.filter((m) => !shown.has(m.messageId));
        const label = `in conversations with ${store.personName(g.person.personId)}:`;
        if (!fresh.length) {
          out.push(`${label} ${g.hits.map((m) => `#${m.messageId}`).join(', ')} (listed above)`);
          continue;
        }
        out.push(label, ...hitLines(ctx, fresh, 0, { start: n }));
        for (const m of fresh) shown.add(m.messageId);
        n += fresh.length;
      }
      if (interpreted.groups.length > 1)
        out.push(
          `"${interpreted.name}" matches ${interpreted.groups.length} people; ask the user which one before acting.`,
        );
    } else if (hits.length) {
      out.push(
        `Messages containing "${q}" (${res.total > hits.length ? `${hits.length} of ${res.total}` : hits.length})`,
        ...hitLines(ctx, hits, 0),
      );
    } else {
      out.push(`Messages containing "${q}" (0)`);
      if (searchNote) out.push(`  ${searchNote}`);
      else if (closest.length)
        out.push(
          `No message has all of: ${words.join(', ')}. Closest matches (some words or word roots):`,
          ...hitLines(ctx, closest, 0),
        );
      else out.push('  none');
      if (filesNote) out.push(filesNote);
    }
    if (labels.length)
      out.push(
        '',
        `Labels: ${labels
          .slice(0, 10)
          .map((l) => `#${l.name} (${l.count})`)
          .join(' · ')} → list_conversations(label=…)`,
      );
    out.push(
      '',
      hint ||
        `More: search_people · list_conversations(query) · search_messages(query)${first ? ` · search_messages(from="${first.personId}") for what they sent` : ''}`,
    );
    return textResult(out.join('\n'));
  },
});
