// What the find tools share: person summaries and lines, message hit lines, and matching chats by name.

import { kindLabel } from '../../domain/attachments.js';
import { senderLabels, shortName } from '../../domain/naming.js';
import { prettyAddress } from '../../lib/address.js';
import { akaOf, isUnknownDm, linkOf, messageText, renderLine } from '../../lib/format.js';
import { dmChatFor, labelMatches, matchPeople, titleMatches } from '../../lib/resolve.js';
import { clip, foldBreaks, oneLine, plural } from '../../lib/text.js';
import { fmtIso, fmtShort } from '../../lib/time.js';
import type { MessageStore } from '../../store/ports.js';
import { type ChatSummary, ME, type Message, type Person } from '../../store/types.js';
import type { Ctx } from '../context.js';
import { renderOpts } from '../results.js';

export const SERVICE = { imessage: 'iMessage', sms: 'SMS', rcs: 'RCS' } as const;
export const NOT_IN_FILES =
  "Text inside photos and PDFs isn't searched; try list_attachments, then get_attachment mode=text.";

export const queryWords = (q: string) => q.match(/"[^"]+"|\S+/g) ?? [];

/** Cuts at a word boundary with "…", never inside a [marker] or a surrogate pair. */
function cutWords(t: string, max: number): string {
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  const open = cut.lastIndexOf('[');
  if (open > 0 && open > cut.lastIndexOf(']')) cut = cut.slice(0, open);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.5) cut = cut.slice(0, sp);
  return `${cut
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()
    .replace(/[,;:-]+$/, '')}…`;
}

/**
 * One redacted line of a message for summaries; codes are hidden before cutting, so no partial code survives the cut.
 */
function snippetOf(ctx: Ctx, m: Message, max: number): string {
  const { store } = ctx;
  let t = oneLine(m.system ? m.system.detail : messageText(store, m, renderOpts(ctx))).trim();
  if (!t && m.attachmentIds.length) {
    const a = store.attachment(m.attachmentIds[0]);
    t = `[${a ? kindLabel(a.kind) : 'attachment'}${m.attachmentIds.length > 1 ? ` +${m.attachmentIds.length - 1}` : ''}]`;
  }
  if (!t && m.link) t = `[link "${linkOf(store, m, ctx.cfg.redactCodes)!.title}"]`;
  if (!t && m.appType) t = `[${m.appType}]`;
  return cutWords(t, max);
}

export function personSummary(ctx: Ctx, p: Person) {
  const { store } = ctx;
  const tz = store.timeZone;
  const act = store.personActivity(p.personId);
  const dm = dmChatFor(store, p.personId);
  const last = act.last;
  const mine = act.lastFromMe;
  return {
    person_id: p.personId,
    name: store.personName(p.personId),
    in_contacts: p.name !== null,
    ...(p.nicknames.length ? { nicknames: p.nicknames } : {}),
    ...(p.aliases.length ? { aliases: p.aliases } : {}),
    ...(p.company ? { company: p.company } : {}),
    ...(p.note ? { note: clip(p.note, 100) } : {}),
    ...(p.labels.length ? { labels: p.labels } : {}),
    handles: p.handles,
    dm_chat_id: dm?.chatId ?? null,
    shared_group_count: act.groupChatIds.length,
    message_count: act.messageCount,
    ...(act.dmMessageCount !== undefined ? { dm_message_count: act.dmMessageCount } : {}),
    ...(act.sentByThemInGroups !== undefined ? { their_group_message_count: act.sentByThemInGroups } : {}),
    last_interaction: last
      ? {
          at: fmtIso(last.sentAt, tz),
          from: last.senderId === ME ? 'me' : store.personName(last.senderId),
          snippet: snippetOf(ctx, last, 80),
          chat_id: last.chatId,
        }
      : null,
    last_from_you: mine
      ? { at: fmtIso(mine.sentAt, tz), snippet: snippetOf(ctx, mine, 80), chat_id: mine.chatId }
      : null,
    needs_reply: act.dmChatIds.some((id) => store.summarizeChat(id).needsReply),
  };
}

type PersonSummary = ReturnType<typeof personSummary>;

export function personLine(ctx: Ctx, p: Person, s: PersonSummary = personSummary(ctx, p)): string {
  const { store } = ctx;
  const tz = store.timeZone,
    now = store.now();
  const extra = [
    p.nicknames.length ? `aka ${p.nicknames.join(', ')}` : '',
    p.aliases.length ? `alias ${p.aliases.join(', ')}` : '',
    p.company ?? '',
    p.note ? `note "${cutWords(oneLine(p.note), 60)}"` : '',
    p.labels.map((l) => `#${l}`).join(' '),
    p.name === null ? 'not in Contacts' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const handles = p.handles.map((h) => `${prettyAddress(h.address)} (${h.services.join('/')})`).join(', ');
  const split = s.their_group_message_count
    ? ` (${s.dm_message_count ?? 0} in 1:1 · ${s.their_group_message_count} by them in groups)`
    : '';
  let last = 'no messages';
  const li = s.last_interaction;
  if (li) {
    last = `last: ${li.from === 'me' ? 'You' : shortName(li.from)} "${cutWords(li.snippet, 50)}" ${fmtShort(Date.parse(li.at), tz, now)}`;
    if (li.from !== 'me')
      last += ` · you: ${s.last_from_you ? fmtShort(Date.parse(s.last_from_you.at), tz, now) : s.shared_group_count ? 'no 1:1 yet' : 'never'}`;
  }
  if (s.needs_reply) last += ' · needs reply';
  return `• ${s.name}${extra ? ` (${extra})` : ''} · person_id ${p.personId}\n  ${handles}\n  dm_chat_id ${s.dm_chat_id ?? '—'} · ${plural(s.shared_group_count, 'shared group')} · ${plural(s.message_count, 'message')}${split} · ${last}`;
}

/** Name, alias and handle matches first (phone and email fragments included), then people whose labels match. */
export function peopleMatching(store: MessageStore, q: string): Person[] {
  const named = matchPeople(store, q, { fragments: true }).map((s) => s.item);
  const seen = new Set(named.map((p) => p.personId));
  return [
    ...named,
    ...store.people().filter((p) => !seen.has(p.personId) && p.labels.length > 0 && labelMatches(q, p.labels)),
  ];
}

/**
 * How a conversation matches free text: its title, a participant, a label, or only a former title (returned as
 * formerly).
 */
export function convoMatch(s: ChatSummary, q: string, people: Set<string>): { formerly?: string } | undefined {
  if (titleMatches(s.title, q) || labelMatches(q, s.chat.labels) || s.chat.participantIds.some((id) => people.has(id)))
    return {};
  const formerly = (s.chat.formerTitles ?? []).find((t) => titleMatches(t, q));
  return formerly ? { formerly } : undefined;
}

export const withFormerly = (s: ChatSummary, formerly?: string): ChatSummary =>
  formerly ? { ...s, title: `${s.title} (formerly ${formerly})` } : s;

function hitHeader(store: MessageStore, chatId: string): string {
  const chat = store.chat(chatId)!;
  const aka = chat.type === 'dm' && chat.participantIds[0] ? akaOf(store, chat.participantIds[0]) : [];
  return foldBreaks(
    `${store.chatTitle(chat)} · ${chat.type === 'dm' ? '1:1' : 'group'}${aka.length ? ` · aka ${aka.join(', ')}` : ''}${isUnknownDm(store, chat) ? ' · not in Contacts' : ''} · chat_id ${chat.chatId}`,
    ' ',
  );
}

/**
 * Search hits in their given order (never regrouped): a chat header only when the chat changes, "N." on each hit.
 * With context, consecutive hits in one chat whose windows overlap print as one window with each hit marked ▶.
 */
export function hitLines(ctx: Ctx, hits: Message[], context: number, opts: { start?: number } = {}): string[] {
  const { store } = ctx;
  const start = opts.start ?? 1;
  const num = (n: number) => `${String(n).padStart(3)}.`;
  const out: string[] = [];
  let prev: string | undefined;
  for (let i = 0; i < hits.length; ) {
    const m = hits[i];
    if (m.chatId !== prev) {
      out.push(hitHeader(store, m.chatId));
      prev = m.chatId;
    } else if (context > 0) out.push('      ⋯');
    const labels = senderLabels(store, store.chat(m.chatId)!);
    if (context <= 0) {
      out.push(renderLine(store, m, labels, renderOpts(ctx, 500), `${num(start + i)} `));
      i++;
      continue;
    }
    const window = store.messagesAround(m.messageId, context, context, false);
    const ids = new Set(window.map((x) => x.messageId));
    const marks = new Map([[m.messageId, start + i]]);
    let j = i + 1;
    for (; j < hits.length && hits[j].chatId === m.chatId; j++) {
      const next = store.messagesAround(hits[j].messageId, context, context, false);
      if (!next.some((x) => ids.has(x.messageId))) break;
      for (const x of next)
        if (!ids.has(x.messageId)) {
          ids.add(x.messageId);
          window.push(x);
        }
      marks.set(hits[j].messageId, start + j);
    }
    window.sort((x, y) => x.sentAt - y.sentAt);
    for (const x of window) {
      const n = marks.get(x.messageId);
      out.push(renderLine(store, x, labels, renderOpts(ctx, 300), n !== undefined ? `${num(n)}▶ ` : '      '));
    }
    i = j;
  }
  return out;
}
