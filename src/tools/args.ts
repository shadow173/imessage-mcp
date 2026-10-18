// Turning loose arguments into store terms: from filters, Gmail-style query tokens, and message or attachment ids.

import { ToolError } from '../lib/errors.js';
import { resolvePerson } from '../lib/resolve.js';
import type { MessageStore } from '../store/ports.js';
import type { FromFilter, Message } from '../store/types.js';

const ANYONE = new Set(['anyone', 'everyone', 'all', 'any', 'anybody']);

export function parseFrom(store: MessageStore, from?: string): FromFilter | undefined {
  if (!from) return undefined;
  const f = from.trim().toLowerCase();
  if (!f || ANYONE.has(f)) return undefined;
  if (f === 'me' || f === 'i' || f === 'myself') return { kind: 'me' };
  if (f === 'others' || f === 'them' || f === 'anyone else') return { kind: 'others' };
  try {
    return { kind: 'person', personId: resolvePerson(store, from).personId };
  } catch (e) {
    if (e instanceof ToolError && e.code === 'person_not_found')
      e.fix = `${e.fix ? `${e.fix} ` : ''}Or use from="me" or from="others", or leave from out.`;
    throw e;
  }
}

export interface QueryTokens {
  from?: string;
  with?: string;
  after?: string;
  before?: string;
  on?: string;
  in?: string;
  has: string[];
  is: string[];
}

/** Lifts Gmail-style tokens (from:sam after:2026-09-01 has:attachment is:unread in:"Cabin") out of free text. */
export function liftQueryTokens(query: string): { text: string; tokens: QueryTokens } {
  const tokens: QueryTokens = { has: [], is: [] };
  const text = query
    .replace(/\b(from|with|after|before|on|in|has|is):("[^"]+"|\S+)/gi, (_m, k: string, v: string) => {
      const key = k.toLowerCase() as keyof QueryTokens;
      const value = v.replace(/^"|"$/g, '');
      if (key === 'has' || key === 'is') tokens[key].push(value.toLowerCase());
      else tokens[key] = value;
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text, tokens };
}

// ---- ids

/** "msg:m1042", "#m1042" and " m1042 " all mean m1042; digits turns "1042" into m1042 (read tools only). */
export function normalizeMessageId(raw: string, opts?: { digits?: boolean }): string {
  const s = raw.trim().replace(/^msg:/i, '').trim().replace(/^#/, '');
  return opts?.digits && /^\d+$/.test(s) ? `m${s}` : s;
}

export function normalizeAttachmentId(raw: string): string {
  return raw.trim().replace(/^att:/i, '').replace(/^#/, '');
}

/** Pass { digits: true } from read tools; write tools never guess a bare number into an id. */
export function findMessage(store: MessageStore, raw: string, opts?: { digits?: boolean }): Message {
  const m = store.message(normalizeMessageId(raw, opts));
  if (!m)
    throw new ToolError(
      'message_not_found',
      `No message has id "${raw.trim()}".`,
      'Message ids look like m1234: transcript lines end with #m1234, search results show msg:m1234. Either form works.',
    );
  return m;
}
