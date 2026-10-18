// Parameter schemas the tools share: times, people, chats, paging, and forgiving enums.

import * as z from 'zod/v4';

export const zTime = (what: string) =>
  z
    .string()
    .optional()
    .describe(
      `${what}. 2026-10-01, 2026-10-01T18:00, 2026-10 (whole month), 2026, relative 3h/3d/2w/30min/6mo/1y or "3 days ago", today, yesterday, this/last week|month|year. Owner's time zone.`,
    );
export const zFrom = z
  .string()
  .optional()
  .describe(
    'Who sent it: "me", "others", or a person (name, alias, phone, email or person_id). Leave it out for anyone.',
  );
const CHAT_DESC =
  'A chat_id, a group name, or a person (your most recently active 1:1 with them; their other 1:1 threads are listed in the result).';
export const zChatReq = z.string().describe(CHAT_DESC);
export const zChatOpt = z.string().optional().describe(CHAT_DESC);
/** For tools that work on a set of chats (search_messages, list_links, get_stats, get_updates). */
export const zChatScopeOpt = z
  .string()
  .optional()
  .describe('A chat_id, a group name, or a person (all your 1:1 threads with them).');
export const zChats = z
  .array(z.string())
  .min(1)
  .max(50)
  .optional()
  .describe('Several chats at once (chat_ids, group names or people). Use instead of chat.');
export const zFormat = z
  .enum(['transcript', 'json'])
  .default('transcript')
  .describe(
    'transcript: compact text lines (default, fewer tokens). json: structured objects, about 3x the tokens; use it only when you need ISO timestamps, ids or delivery fields.',
  );
export const zLimit = (def: number, max: number) =>
  z.number().int().min(1).max(max).default(def).describe(`Max results. Default ${def}, max ${max}.`);
export const zCursor = z
  .string()
  .optional()
  .describe(
    'Opaque cursor from a previous call of this same tool, with the same query and filters. Omit on the first call. A null next_cursor means the last page was returned: stop.',
  );

type Choices = readonly [string, ...string[]];

/**
 * Trims, lowercases, maps spaces/hyphens to "_" and applies aliases ("photo" -> "image", "😂" -> "laugh"), so
 * near-misses still parse.
 */
function normalizeChoice(values: Choices, aliases?: Record<string, string>) {
  return (v: unknown) => {
    if (typeof v !== 'string') return v;
    const raw = v.trim();
    if (values.includes(raw)) return raw;
    const lower = raw.toLowerCase();
    const key = lower.replace(/[\s-]+/g, '_');
    return aliases?.[raw] ?? aliases?.[lower] ?? aliases?.[key] ?? (values.includes(lower) ? lower : key);
  };
}

/**
 * An enum that forgives case, spacing and aliases. tools/list still advertises a plain enum. Put .default() outside (it
 * is then not advertised).
 */
export function zOneOf<const T extends Choices>(values: T, aliases?: Record<string, string>) {
  return z.preprocess(normalizeChoice(values, aliases), z.enum(values));
}

/** An array of enum values that also accepts one string or a comma list. tools/list still advertises array-of-enum. */
export function zList<const T extends Choices>(values: T, aliases?: Record<string, string>) {
  return z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(zOneOf(values, aliases)),
  );
}
