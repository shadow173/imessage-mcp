// How chat.db stores tapbacks: a row of its own whose associated_message_* columns point at the message it reacts to.

import type { ReactionKind } from '../store/types.js';

const REACTIONS: ReactionKind[] = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'emoji'];

/**
 * message.associated_message_type for tapbacks: 2000 + n adds one, 3000 + n takes it back, where n indexes REACTIONS
 * (6 is an emoji tapback) and 7 is a sticker placed on the message.
 */
export const TAPBACK_SQL = (col = 'associated_message_type') =>
  `(${col} BETWEEN 2000 AND 2007 OR ${col} BETWEEN 3000 AND 3007)`;
export const isTapbackType = (t: number) => (t >= 2000 && t <= 2007) || (t >= 3000 && t <= 3007);

/** A tapback row's kind and whether it takes one back; null for stickers and anything that isn't a tapback. */
export function decodeTapback(t: number): { kind: ReactionKind; removed: boolean } | null {
  if (!isTapbackType(t) || t % 1000 > 6) return null;
  return { kind: REACTIONS[t % 1000], removed: t >= 3000 };
}

/** chat.db tapback target: "bp:<guid>", "p:<part>/<guid>" or the bare guid. */
const TAPBACK_TARGET = /^(?:bp:|p:(\d+)\/)?(.*)$/;
export const tapbackTarget = (ag: string) => {
  const m = TAPBACK_TARGET.exec(ag)!;
  return { part: Number(m[1] ?? 0), guid: m[2] };
};

/** Every associated_message_guid a tapback on one of a message's parts can carry (an indexed IN lookup, no LIKE). */
export const tapbackCandidates = (guid: string, partCount = 1) => [
  guid,
  `bp:${guid}`,
  ...Array.from({ length: Math.min(32, Math.max(4, partCount)) }, (_, i) => `p:${i}/${guid}`),
];
