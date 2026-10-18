import { chatGuidIdentifier, isChatGuid, sameChatGuid } from '../domain/chatGuid.js';
import { normLabel } from '../domain/naming.js';
import { redact } from '../policy/redact.js';
import type { MessageStore } from '../store/ports.js';
import { type Chat, type ChatTarget, ME, type Message, type Person } from '../store/types.js';
import { addressKey, isPhoneShaped, normalizeAddress, prettyAddress } from './address.js';
import { type Candidate, ToolError } from './errors.js';
import { clip, oneLine } from './text.js';
import { fmtShort } from './time.js';

/** How a hit matched; 'alias' hits lose to another person's name on write tools. */
export type MatchVia =
  | 'name'
  | 'nickname'
  | 'alias'
  | 'first'
  | 'initial'
  | 'token'
  | 'prefix'
  | 'company'
  | 'handle'
  | 'suffix'
  | 'fragment'
  | 'title'
  | 'former';
export interface Scored<T> {
  item: T;
  score: number;
  via?: MatchVia;
}
/** strict = write tools: only a unique match scoring >= 2 (whole word or better) or an exact id resolves. */
export interface ResolveOpts {
  strict?: boolean;
}

interface PersonScored extends Scored<Person> {
  nameScore: number;
}
type Hit = (PersonScored & { kind: 'person' }) | (Scored<Chat> & { kind: 'chat'; formerly?: string });

const FILLER = new Set(['the', 'my', 'our', 'group', 'chat', 'gc', 'groupchat', 'thread', 'convo', 'conversation']);
const GROUP_WORDS = new Set(['group', 'gc', 'groupchat']);
const LEAD = /^(?:my|our|the)\s+/;
const STRICT_FIX_PERSON = 'Ask the user which one they mean, then pass that person_id.';
const STRICT_FIX_CHAT = 'Ask the user which one they mean, then pass that chat_id or person_id.';
const READ_FIX_PERSON =
  'Pass one of these person_ids instead of the name; if it is a search filter, each result names its sender, so you can also drop the filter.';
const READ_FIX_CHAT = 'Pass one of these person_ids (or chat_ids) instead of the name.';
const NAME_NOT_FOUND_FIX =
  'Try find with part of the name; if the user described the person ("from the climbing gym"), find or search_messages with those words shows who said them. A phone number or email also works.';
const ADDRESS_NOT_FOUND_FIX =
  'Check the number with the user. Tools that accept new numbers or emails (send_message, manage_group) say so in their description.';
const CHAT_NOT_FOUND_FIX =
  'Group names often differ from the saved title: call list_conversations with type=group, or find with one distinctive word. Businesses and unknown numbers have no name: find with a word from their messages shows their chat_id, and update_person add_aliases can name them.';
const NO_CONVERSATION_FIX = 'send_message starts one; this tool needs an existing conversation.';
const NOT_SENT_YET =
  'If a send to it just came back MAY_HAVE_COMPLETED or unconfirmed, it has not gone out as far as the Mac can see.';
const NOT_SENT_YET_FIX = 'Ask the user before sending again; never resend with a new idempotency_key on your own.';
const INCOMPLETE_FIX =
  'Pass all 10 digits (or + and the country code) or the full email address; find with the last 4 or more digits lists matching contacts.';

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const contentTokens = (s: string) => tokens(s).filter((t) => !FILLER.has(t));
const stripLead = (s: string) => s.replace(LEAD, '').trim();
const sameTokens = (a: string, b: string) => {
  const ta = tokens(a);
  return ta.length > 0 && ta.join(' ') === tokens(b).join(' ');
};
const formerTitlesOf = (c: Chat) => (c as { formerTitles?: string[] }).formerTitles ?? [];
const lastAt = (store: MessageStore, c: Chat) => store.summarizeChat(c.chatId).lastMessage?.sentAt ?? 0;
/**
 * "555-0188", "priya@": address-shaped but not a full number or email, so it must not fall back to name matching on
 * writes.
 */
const incompleteAddress = (s: string, addr: string | null) => !addr && (isPhoneShaped(s) || s.includes('@'));
const byRecency = (store: MessageStore, chats: Chat[]) =>
  chats
    .map((c) => ({ c, last: lastAt(store, c) }))
    .sort((a, b) => b.last - a.last)
    .map((x) => x.c);

/** "Linda Carter (aka Mom)" -> "Linda Carter", so labels copied from tool output still resolve. */
function stripDecoration(s: string): string {
  if (isChatGuid(s)) return s;
  return s.replace(/\s*\((?:aka\s+|formerly\s+)?[^)]*\)\s*$/i, '').trim() || s;
}

/** The id in a copied candidate line: "Sam Lee (person_id p_sam_lee)", "Cabin (chat_id iMessage;+;chat1)". */
function decorationId(s: string): string | undefined {
  return /\((?:person_id|chat_id)?\s*([^()\s]+)\)\s*$/i.exec(s)?.[1];
}

function sameGuid(a: string, b: string): boolean {
  return a === b || sameChatGuid(a.toLowerCase(), b.toLowerCase());
}

/**
 * Exact chat_id first; a prefix variant ('any;-;+1555…') falls back to the most recently active thread with that tail.
 */
function exactChat(store: MessageStore, q: string): Chat | undefined {
  const direct = store.chat(q);
  if (direct?.chatId === q) return direct;
  if (!isChatGuid(q)) return undefined;
  return byRecency(
    store,
    store.chats().filter((c) => sameGuid(c.chatId, q)),
  )[0];
}

function personScore(p: Person, query: string): { score: number; via?: MatchVia; nameScore: number } {
  const raw = query.toLowerCase().trim();
  const ql = raw.replace(/[.,;:!?]+$/u, '').trim();
  const qt = contentTokens(ql);
  const name = p.name?.toLowerCase() ?? '';
  const entries: [string, 'name' | 'nickname' | 'alias'][] = [
    ...(name ? [[name, 'name'] as [string, 'name']] : []),
    ...p.nicknames.map((n) => [n.toLowerCase(), 'nickname'] as [string, 'nickname']),
    ...p.aliases.map((n) => [n.toLowerCase(), 'alias'] as [string, 'alias']),
  ];
  let score = 0,
    nameScore = 0,
    via: MatchVia | undefined;
  const hit = (s: number, v: MatchVia) => {
    if (s > score) {
      score = s;
      via = v;
    }
    if (v !== 'alias' && s > nameScore) nameScore = s;
  };
  for (const [n, kind] of entries) {
    const nt = tokens(n);
    if (n === raw || n === ql || sameTokens(n, ql)) hit(3, kind);
    else if (qt.length && qt.every((w) => nt.includes(w))) hit(2, kind === 'name' ? 'token' : kind);
    else if (qt.length && qt.every((w) => nt.some((t) => t.startsWith(w)))) hit(1.5, kind === 'name' ? 'prefix' : kind);
  }
  // "my landlord" ~ alias "landlord", "the roommate" ~ alias "my roommate", "my mom" ~ nickname "Mom"; never the
  // Contacts name ("My Tran").
  const bare = stripLead(ql);
  if (score < 3 && bare) for (const [n, kind] of entries) if (kind !== 'name' && stripLead(n) === bare) hit(3, kind);
  if (name) {
    // Mirrors senderLabels: first word, or "First L." when two people in a chat share a first name.
    const parts = name.split(' ');
    if (parts[0] === raw || parts[0] === ql || (qt.length === 1 && tokens(name)[0] === ql)) hit(2, 'first');
    const initial = parts.length > 1 ? parts[parts.length - 1][0] : undefined;
    if (initial && ql === `${parts[0]} ${initial}`) hit(2, 'initial');
  }
  if (p.company && qt.length) {
    const ct = tokens(p.company);
    if (qt.every((w) => ct.some((t) => t.startsWith(w)))) hit(1, 'company');
  }
  return { score, via, nameScore };
}

/** Exact handle = 3; a handle merely ending with the digits (a short code, "0142") = 1, which write tools ignore. */
function addressHits(store: MessageStore, addr: string): PersonScored[] {
  const tail = addr.startsWith('+') ? addr.replace(/^\+1?/, '') : addr;
  const out: PersonScored[] = [];
  for (const item of store.people()) {
    const keys = item.handles.map((h) => addressKey(h.address));
    if (keys.includes(addr)) out.push({ item, score: 3, via: 'handle', nameScore: 3 });
    else if (keys.some((k) => k.endsWith(tail))) out.push({ item, score: 1, via: 'suffix', nameScore: 1 });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Ranked people matching free text: 3 exact (name, nickname, alias, handle), 2 whole words / first name / "First L.",
 * 1.5 word prefixes, 1 company or handle suffix. Mid-word fragments never match.
 * fragments (read-only lists): 7+ digit phone fragments (2) and email fragments (1) also match handles.
 */
export function matchPeople(store: MessageStore, query: string, opts: { fragments?: boolean } = {}): Scored<Person>[] {
  const q = query.trim();
  const plain = stripDecoration(q);
  const addr = normalizeAddress(q) ?? normalizeAddress(plain);
  if (addr) return addressHits(store, addr);
  const out = new Map<string, PersonScored>();
  const add = (item: Person, score: number, via: MatchVia | undefined, nameScore: number) => {
    const cur = out.get(item.personId);
    if (!cur || score > cur.score)
      out.set(item.personId, { item, score, via, nameScore: Math.max(nameScore, cur?.nameScore ?? 0) });
    else cur.nameScore = Math.max(cur.nameScore, nameScore);
  };
  if (opts.fragments) {
    const digits = q.replace(/\D/g, '');
    if (isPhoneShaped(q) && digits.length >= 7)
      for (const p of store.people())
        if (p.handles.some((h) => h.address.replace(/\D/g, '').endsWith(digits))) add(p, 2, 'fragment', 2);
    const ql = q.toLowerCase();
    if (/^[^\s]*[@.][^\s]*$/.test(ql) && ql.length >= 4)
      for (const p of store.people())
        if (p.handles.some((h) => h.address.toLowerCase().includes(ql))) add(p, 1, 'fragment', 1);
  }
  for (const p of store.people()) {
    for (const v of plain === q ? [q] : [q, plain]) {
      const s = personScore(p, v);
      if (s.score) add(p, s.score, s.via, s.nameScore);
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

/**
 * Picks the winner or explains why there isn't one: a tie, a loose lone match (strict), or an alias shadowing someone's
 * name (strict).
 */
function select(hits: Hit[], strict: boolean): { hit: Hit } | { reason: 'tie' | 'loose' | 'alias'; candidates: Hit[] } {
  const best = Math.max(...hits.map((h) => h.score));
  const top = hits.filter((h) => h.score === best);
  if (top.length > 1) return { reason: 'tie', candidates: top };
  const h = top[0];
  if (strict && best < 2) return { reason: 'loose', candidates: [h] };
  if (strict && h.kind === 'person' && h.via === 'alias' && h.nameScore < 2) {
    const rivals = hits.filter((o) => o !== h && o.kind === 'person' && o.nameScore >= 2);
    if (rivals.length) return { reason: 'alias', candidates: [h, ...rivals] };
  }
  return { hit: h };
}

function hitLabel(store: MessageStore, h: Hit): string {
  return h.kind === 'person' ? store.personName(h.item.personId) : store.chatTitle(h.item);
}

function ambiguity(
  store: MessageStore,
  code: 'ambiguous_person' | 'ambiguous_chat',
  q: string,
  r: { reason: 'tie' | 'loose' | 'alias'; candidates: Hit[] },
  strict: boolean,
): ToolError {
  const [first, ...rest] = r.candidates;
  const message =
    r.reason === 'loose'
      ? `"${q}" only partly matches ${hitLabel(store, first)}.`
      : r.reason === 'alias'
        ? `"${q}" is a saved alias of ${hitLabel(store, first)}, but also the name of ${rest.map((h) => hitLabel(store, h)).join(' and ')}.`
        : code === 'ambiguous_person'
          ? `"${q}" matches ${r.candidates.length} people.`
          : `"${q}" matches more than one conversation or person.`;
  const fix = strict
    ? code === 'ambiguous_person'
      ? STRICT_FIX_PERSON
      : STRICT_FIX_CHAT
    : code === 'ambiguous_person'
      ? READ_FIX_PERSON
      : READ_FIX_CHAT;
  const candidates = r.candidates
    .slice(0, 8)
    .map((h) =>
      h.kind === 'person' ? personCandidate(store, h.item) : chatCandidate(store, h.item, { formerly: h.formerly }),
    );
  return new ToolError(code, message, fix, candidates);
}

function personNotFound(q: string, addr: string | null): ToolError {
  if (addr)
    return new ToolError(
      'person_not_found',
      `No contact or conversation uses ${prettyAddress(addr)}.`,
      ADDRESS_NOT_FOUND_FIX,
    );
  if (incompleteAddress(stripDecoration(q), addr))
    return new ToolError('person_not_found', `"${q}" is not a complete phone number or email.`, INCOMPLETE_FIX);
  return new ToolError('person_not_found', `No person matches "${q}".`, NAME_NOT_FOUND_FIX);
}

/** Resolves a person reference or throws person_not_found / ambiguous_person with candidates. */
export function resolvePerson(store: MessageStore, input: string, opts: ResolveOpts = {}): Person {
  const q = input.trim();
  const id = decorationId(q);
  const direct = store.person(q) ?? (id ? store.person(id) : undefined);
  if (direct) return direct;
  const strict = !!opts.strict;
  const addr = normalizeAddress(q) ?? normalizeAddress(stripDecoration(q));
  let hits = matchPeople(store, q) as PersonScored[];
  if (strict && (addr || incompleteAddress(stripDecoration(q), addr))) hits = hits.filter((h) => h.score >= 3);
  if (!hits.length) throw personNotFound(q, addr);
  const r = select(
    hits.map((h) => ({ ...h, kind: 'person' as const })),
    strict,
  );
  if ('reason' in r) throw ambiguity(store, 'ambiguous_person', q, r, strict);
  return r.hit.item as Person;
}

/** Every 1:1 chat with a person across their handles and services, most recently active first. */
export function dmChatsFor(store: MessageStore, personId: string): Chat[] {
  return byRecency(
    store,
    store.chats().filter((c) => c.type === 'dm' && c.participantIds[0] === personId),
  );
}

/** Most recent 1:1 chat for a person, across all their handles and services. */
export function dmChatFor(store: MessageStore, personId: string): Chat | undefined {
  return dmChatsFor(store, personId)[0];
}

/** The person's other 1:1 threads (another number, their email, the old SMS thread). */
export function siblingDms(store: MessageStore, chat: Chat): Chat[] {
  const pid = chat.type === 'dm' ? chat.participantIds[0] : undefined;
  return pid ? dmChatsFor(store, pid).filter((c) => c.chatId !== chat.chatId) : [];
}

function groupScore(
  store: MessageStore,
  c: Chat,
  variants: string[],
): { score: number; via?: MatchVia; formerly?: string } {
  const title = store.chatTitle(c);
  const tt = tokens(title);
  let best = 0,
    via: MatchVia | undefined,
    formerly: string | undefined;
  for (const v of variants) {
    const raw = v.toLowerCase().trim();
    const qt = contentTokens(v);
    let s =
      title.toLowerCase() === raw || sameTokens(title, v)
        ? 3
        : qt.length && qt.every((w) => tt.includes(w))
          ? 2
          : qt.length && qt.every((w) => tt.some((t) => t.startsWith(w)))
            ? 1.5
            : 0;
    // A generated title ("Linda, Emma") is just first names: a person's own first name must still win.
    if (!c.displayName && (s < 3 || tt.length < 2)) s = Math.min(s, 1.5);
    if (s > best) {
      best = s;
      via = 'title';
      formerly = undefined;
    }
    if (best < 2) {
      const f = formerTitlesOf(c).find((t) => t.toLowerCase() === raw || sameTokens(t, v));
      if (f) {
        best = 2;
        via = 'former';
        formerly = f;
      }
    }
  }
  return { score: best, via, formerly };
}

/** Group chats sharing a word (or a 4+ letter prefix) with the query: suggestions only, never auto-resolved. */
function nearChats(store: MessageStore, qt: string[]): { chat: Chat; formerly?: string }[] {
  const prefixLen = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  };
  const overlap = (title: string) => {
    const tt = tokens(title);
    return qt.filter((w) => tt.some((t) => t === w || prefixLen(t, w) >= 4)).length;
  };
  return store
    .chats()
    .filter((c) => c.type === 'group')
    .map((chat) => {
      let n = overlap(store.chatTitle(chat)),
        formerly: string | undefined;
      for (const f of formerTitlesOf(chat)) {
        const m = overlap(f);
        if (m > n) {
          n = m;
          formerly = f;
        }
      }
      return { chat, n, formerly };
    })
    .filter((x) => x.n > 0)
    .map((x) => ({ ...x, last: lastAt(store, x.chat) }))
    .sort((a, b) => b.n - a.n || b.last - a.last)
    .slice(0, 3)
    .map(({ chat, formerly }) => ({ chat, formerly }));
}

function personTarget(
  store: MessageStore,
  p: Person,
  allowNew: boolean,
  addr?: string | null,
): { target: ChatTarget; person: Person } {
  const dm = dmChatFor(store, p.personId);
  if (dm) return { target: { chat: dm }, person: p };
  const handle = (addr ? p.handles.find((h) => addressKey(h.address) === addr) : undefined) ?? p.handles[0];
  if (allowNew && handle) return { target: { newAddress: handle.address, person: p }, person: p };
  throw new ToolError(
    'no_conversation',
    `You have no 1:1 conversation with ${store.personName(p.personId)} yet.`,
    'Use get_person to see group chats you share, or send_message to start one.',
  );
}

function resolveTarget(
  store: MessageStore,
  input: string,
  allowNew: boolean,
  strict: boolean,
): { target: ChatTarget; person?: Person } {
  const q = input.trim();
  const id = decorationId(q);
  const exact = exactChat(store, q) ?? (id && isChatGuid(id) ? exactChat(store, id) : undefined);
  if (exact) return { target: { chat: exact } };
  if (isChatGuid(q)) {
    // "any;-;+1555…" is the chat_id a send result prints before Messages has made the thread.
    const tail = normalizeAddress(chatGuidIdentifier(q));
    if (tail && /^[^;]+;-;/.test(q))
      throw new ToolError(
        'chat_not_found',
        `No conversation with ${prettyAddress(tail)} is in chat.db yet. ${NOT_SENT_YET}`,
        NOT_SENT_YET_FIX,
      );
    throw new ToolError(
      'chat_not_found',
      `No conversation has chat_id "${q}".`,
      'Use find or list_conversations to get a valid chat_id.',
    );
  }
  const byId = store.person(q) ?? (id ? store.person(id) : undefined);
  if (byId) return personTarget(store, byId, allowNew);

  const plain = stripDecoration(q);
  const variants = plain === q ? [q] : [q, plain];
  const addr = normalizeAddress(q) ?? normalizeAddress(plain);
  // "cabin group", "Jo gc": a group word means a group chat, never Jo's 1:1.
  const groupOnly = tokens(plain).some((w) => GROUP_WORDS.has(w));
  const hits: Hit[] = [];
  for (const c of store.chats()) {
    if (c.type !== 'group') continue;
    const s = groupScore(store, c, variants);
    if (s.score) hits.push({ kind: 'chat', item: c, score: s.score, via: s.via, formerly: s.formerly });
  }
  // On write paths a number, short code or email must match a handle exactly: "50142" is never a contact ending in
  // 50142.
  const exactOnly = ((!!addr || incompleteAddress(plain, addr)) && (allowNew || strict)) || groupOnly;
  const people = matchPeople(store, q) as PersonScored[];
  for (const h of people) if (!exactOnly || h.score >= 3) hits.push({ ...h, kind: 'person' });
  // Four digits on a write is the tail of a number far more often than a short code (US short codes have 5 or 6).
  if (!hits.length && addr && /^\d{4}$/.test(addr) && (allowNew || strict)) {
    const tails = people
      .filter((h) => h.via === 'suffix')
      .slice(0, 8)
      .map((h) => personCandidate(store, h.item));
    throw new ToolError(
      tails.length ? 'ambiguous_chat' : 'chat_not_found',
      `"${q}" is only 4 digits: not a complete phone number, and no conversation uses it as a short code.${tails.length ? ` It is the end of ${tails.map((c) => c.label).join(', ')}.` : ''}`,
      tails.length
        ? 'Ask the user which one they mean, then pass that person_id or the full number. Nothing was sent.'
        : `${INCOMPLETE_FIX} US short codes have 5 or 6 digits.`,
      tails,
    );
  }
  if (!hits.length) {
    if (addr && allowNew) return { target: { newAddress: addr } };
    if (addr)
      throw new ToolError(
        'chat_not_found',
        `No conversation uses ${prettyAddress(addr)}: no message to or from it is in chat.db. ${NOT_SENT_YET}`,
        `${NOT_SENT_YET_FIX} Otherwise check the number with the user, or call find with its last 4 digits. Only send_message and create_draft start a conversation with a new number or email.`,
      );
    if (incompleteAddress(plain, addr))
      throw new ToolError('chat_not_found', `"${q}" is not a complete phone number or email.`, INCOMPLETE_FIX);
    const qt = contentTokens(plain);
    const near = qt.length ? nearChats(store, qt) : [];
    if (near.length) {
      throw new ToolError(
        'chat_not_found',
        `No conversation or person matches "${q}".`,
        'No exact match. If one of these is the chat the user means, pass its chat_id; otherwise ask the user.',
        near.map((n) => chatCandidate(store, n.chat, { formerly: n.formerly })),
      );
    }
    throw new ToolError('chat_not_found', `No conversation or person matches "${q}".`, CHAT_NOT_FOUND_FIX);
  }
  const r = select(hits, strict);
  if ('reason' in r) throw ambiguity(store, 'ambiguous_chat', q, r, strict);
  if (r.hit.kind === 'chat') return { target: { chat: r.hit.item } };
  return personTarget(store, r.hit.item, allowNew, addr);
}

/**
 * Resolves a `chat` argument: a chat_id, a group title, or a person (meaning their most recent 1:1 chat).
 * With allowNew, a person or address with no chat yet resolves to a new-conversation target.
 * strict (defaults to allowNew) is for write tools: only a unique whole-word match or an exact id resolves.
 */
export function resolveChat(store: MessageStore, input: string, allowNew = false, opts: ResolveOpts = {}): ChatTarget {
  return resolveTarget(store, input, allowNew, opts.strict ?? allowNew).target;
}

/** For tools that need an existing chat: returns it or throws. */
export function requireChat(store: MessageStore, input: string, opts: ResolveOpts = {}): Chat {
  const t = resolveChat(store, input, false, { strict: !!opts.strict });
  if ('chat' in t) return t.chat;
  throw new ToolError('no_conversation', 'No conversation exists for that recipient yet.', NO_CONVERSATION_FIX);
}

/** For set-based reads: a person covers all their 1:1 threads; a chat_id or group is just that chat. */
export function resolveChatScope(
  store: MessageStore,
  input: string,
): { chat: Chat; chatIds: string[]; personId?: string } {
  const r = resolveTarget(store, input, false, false);
  if (!('chat' in r.target))
    throw new ToolError('no_conversation', 'No conversation exists for that recipient yet.', NO_CONVERSATION_FIX);
  const chat = r.target.chat;
  if (r.person && chat.type === 'dm')
    return { chat, chatIds: dmChatsFor(store, r.person.personId).map((c) => c.chatId), personId: r.person.personId };
  return { chat, chatIds: [chat.chatId] };
}

/** True when `input` names this chat exactly (its chat_id or its full title), not by a partial match. */
export function isExactChatRef(store: MessageStore, chat: Chat, input: string): boolean {
  const q = input.trim();
  const id = decorationId(q);
  if (sameGuid(chat.chatId, q) || (id !== undefined && sameGuid(chat.chatId, id))) return true;
  const title = store.chatTitle(chat);
  return [q, stripDecoration(q)].some((v) => title.toLowerCase() === v.toLowerCase() || sameTokens(title, v));
}

/** Read-side list filter: substring, or every non-filler word starts a word of the title (or a former title). */
export function titleMatches(title: string, query: string, formerTitles: string[] = []): boolean {
  const ql = query.toLowerCase().trim();
  const qt = contentTokens(query);
  return [title, ...formerTitles].some(
    (t) => t.toLowerCase().includes(ql) || (qt.length > 0 && qt.every((w) => tokens(t).some((x) => x.startsWith(w)))),
  );
}

/** Whole-word label match with plural tolerance ("trips" ~ trip), never substring ("tri" !~ trip). */
export function labelMatches(query: string, labels: string[]): boolean {
  const q = normLabel(query);
  if (!q) return false;
  const one = (w: string) => w.replace(/s$/, '');
  const words = q.split(/\s+/).map(normLabel).filter(Boolean);
  const phrase = ` ${words.join(' ')} `;
  return labels
    .map(normLabel)
    .filter(Boolean)
    .some((l) => one(l) === one(q) || words.some((w) => one(w) === one(l)) || phrase.includes(` ${l} `));
}

/**
 * Count and last message for a candidate, from the cheap per-chat summaries; the full aggregate only when there's no
 * 1:1.
 */
function candidateActivity(store: MessageStore, p: Person): { count: number; last?: Message } {
  const dms = store.chats().filter((c) => c.type === 'dm' && c.participantIds[0] === p.personId);
  if (!dms.length) {
    const a = store.personActivity(p.personId);
    return { count: a.messageCount, last: a.last };
  }
  let count = 0,
    last: Message | undefined;
  for (const c of dms) {
    const s = store.summarizeChat(c.chatId);
    count += s.messageCount;
    if (s.lastMessage && (!last || s.lastMessage.sentAt > last.sentAt)) last = s.lastMessage;
  }
  return { count, last };
}

/**
 * A 40-char last-message snippet, codes hidden unless REDACT_CODES is off; only for Contacts names (unknown senders
 * carry injection text).
 */
function candidateSnippet(store: MessageStore, p: Person, m: Message): string {
  if (p.name === null || m.system || (m.senderId !== ME && m.senderId !== p.personId)) return '';
  const text = m.unsent
    ? '[unsent]'
    : oneLine(redact(m.text, m.senderId === ME ? undefined : p.handles[0]?.address, store.redactCodes)).trim();
  return text ? ` ${m.senderId === ME ? 'You: ' : ''}"${clip(text, 40)}"` : '';
}

export function personCandidate(store: MessageStore, p: Person): Candidate {
  const label = store.personName(p.personId);
  const bits: string[] = [];
  if (p.note) bits.push(`note: ${clip(oneLine(p.note), 60)}`);
  const aka = [...new Set([...p.nicknames, ...p.aliases])];
  if (aka.length) bits.push(`aka ${aka.join(', ')}`);
  if (p.labels.length) bits.push(p.labels.map((l) => `#${l}`).join(' '));
  if (p.name === null) bits.push('not in Contacts');
  const act = candidateActivity(store, p);
  if (act.count) bits.push(`${act.count} msgs`);
  if (act.last)
    bits.push(`last ${fmtShort(act.last.sentAt, store.timeZone, store.now())}${candidateSnippet(store, p, act.last)}`);
  const handles = p.handles.map((h) => prettyAddress(h.address)).filter((h) => h !== label);
  if (handles.length) bits.push(handles.join(', '));
  return { kind: 'person', id: p.personId, label, detail: bits.join(' · ') };
}

export function chatCandidate(store: MessageStore, c: Chat, opts: { formerly?: string } = {}): Candidate {
  const bits = [c.type === 'dm' ? `1:1 · ${c.service}` : `group of ${c.participantIds.length + 1}`];
  if (c.type === 'group' && c.displayName && c.participantIds.length) {
    const names = c.participantIds.slice(0, 3).map((id) => store.personName(id));
    bits.push(names.join(', ') + (c.participantIds.length > 3 ? ` +${c.participantIds.length - 3}` : ''));
  }
  const last = lastAt(store, c);
  if (last) bits.push(`last ${fmtShort(last, store.timeZone, store.now())}`);
  return {
    kind: 'chat',
    id: c.chatId,
    label: store.chatTitle(c) + (opts.formerly ? ` (formerly ${opts.formerly})` : ''),
    detail: bits.join(' · '),
  };
}
