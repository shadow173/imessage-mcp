import { prettyAddress } from '../lib/address.js';
import type { MessageStore } from '../store/ports.js';
import { type Chat, ME, type Person } from '../store/types.js';
import { chatGuidIdentifier } from './chatGuid.js';

/** First word of a name; phone-number names ("(555) 555-0188", "+44 …") stay whole. */
export const shortName = (n: string) => (n.startsWith('(') || n.startsWith('+') ? n : n.split(' ')[0]);

/** Per-chat sender labels: first name, or first name + last initial when two share a first name. */
export function senderLabels(store: Pick<MessageStore, 'personName'>, chat: Chat): Map<string, string> {
  const ids = [...chat.participantIds];
  const full = ids.map((id) => store.personName(id));
  const shorts = full.map(shortName);
  const counts = new Map<string, number>();
  for (const s of shorts) counts.set(s, (counts.get(s) ?? 0) + 1);
  const out = new Map<string, string>([[ME, 'You']]);
  ids.forEach((id, i) => {
    const parts = full[i].split(' ');
    out.set(
      id,
      (counts.get(shorts[i]) ?? 0) > 1 && shorts[i] !== full[i] && parts.length > 1
        ? `${shorts[i]} ${parts[parts.length - 1][0]}.`
        : shorts[i],
    );
  });
  return out;
}

/**
 * A label (#tag) as it is stored and compared: trimmed, lowercase, without a leading "#".
 * @example normLabel(' #Trip ') // 'trip'
 */
export const normLabel = (s: string) => s.trim().toLowerCase().replace(/^#/, '');

/**
 * How a person is shown: "You" for the owner, then their Contacts name, then their first handle. `missing` is what an
 * id with no person gets; the stores differ there (the live store has real unknown senders, the mock never does).
 */
export function personDisplayName(id: string, p: Person | undefined, missing: string): string {
  if (id === ME) return 'You';
  return p ? (p.name ?? prettyAddress(p.handles[0]?.address ?? id)) : missing;
}

/** A chat's title: its group name, the other person for a 1:1, else up to four members' first names. */
export function chatTitle(store: Pick<MessageStore, 'personName'>, c: Chat): string {
  if (c.displayName) return c.displayName;
  if (c.type === 'dm')
    return c.participantIds[0] ? store.personName(c.participantIds[0]) : prettyAddress(chatGuidIdentifier(c.chatId));
  const labels = [...senderLabels(store, c).entries()].filter(([id]) => id !== ME).map(([, l]) => l);
  return labels.length > 4 ? `${labels.slice(0, 4).join(', ')} +${labels.length - 4}` : labels.join(', ') || 'Group';
}

/** A 1:1 with someone who isn't in Contacts (other: the person on the other side, if the directory has one). */
export const isUnknownSender = (c: Chat, other: Person | undefined) =>
  c.type === 'dm' && (!other || other.name === null);
