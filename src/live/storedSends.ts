// What an earlier send with the same idempotency key left in the sidecar, so a retry replays it instead of sending twice.

import {
  type IdempotencyRow,
  IN_FLIGHT_SENDS,
  interruptedSend,
  isPendingSend,
  type StoredSend,
} from '../store/idempotency.js';
import type { Message, SendResult } from '../store/types.js';
import type { Sidecar } from './sidecar.js';

/**
 * The stored outcome the sender would replay for key (rows from before fingerprints carry no fp and count as a match),
 * 'in_progress' while that send is still running in this bridge (bootId), or undefined when a send may go ahead.
 */
export function lookupStoredSend(
  side: Sidecar,
  bootId: string,
  key: string,
  message: (id: string) => Message | undefined,
): { result: SendResult; fp?: string } | 'in_progress' | undefined {
  if (IN_FLIGHT_SENDS.has(key)) return 'in_progress';
  const row = side.db.prepare('select result from idempotency where key = ?').get(key) as
    | { result: string }
    | undefined;
  if (!row) return undefined;
  const stored = JSON.parse(row.result) as IdempotencyRow;
  // Pending: running in this bridge, or interrupted by a restart (the sender settles that as outcome unknown).
  if (isPendingSend(stored) && stored.boot === bootId) return 'in_progress';
  const p: StoredSend = isPendingSend(stored) ? interruptedSend(stored) : stored;
  if (p.disposition === 'failed' && p.retrySafe) return undefined;
  const result: SendResult = {
    disposition: p.disposition,
    chatId: p.chatId,
    message: p.messageId ? message(p.messageId) : undefined,
    error: p.error,
    retrySafe: p.retrySafe,
    ...(p.attachments ? { attachments: p.attachments } : {}),
  };
  return { result, ...(p.fp ? { fp: p.fp } : {}) };
}
