// When a conversation counts as waiting on the owner's reply. Both stores apply this rule to a chat's last message.

import { isShortCode } from '../lib/address.js';
import { DAY_MS } from '../lib/units.js';
import type { Person } from '../store/types.js';

/** Older conversations don't count as waiting on a reply. */
export const NEEDS_REPLY_WINDOW_MS = 14 * DAY_MS;

/** A 1:1 with an automated sender (a short code): nobody expects an answer. */
export const isShortCodePerson = (p: Person | undefined) => !!p && p.handles.some((h) => isShortCode(h.address));

/**
 * The last message is from someone else, recent, not from a short code, and the owner hasn't acknowledged it with a
 * tapback that still stands.
 */
export function needsReply(last: { fromOwner: boolean; ageMs: number; shortCode: boolean; ownerTapback: boolean }) {
  return !last.fromOwner && !last.shortCode && last.ageMs < NEEDS_REPLY_WINDOW_MS && !last.ownerTapback;
}
