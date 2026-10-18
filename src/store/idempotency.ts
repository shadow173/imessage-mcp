import { createHash } from 'node:crypto';
import { chatGuidIdentifier, chatGuidSuffix } from '../domain/chatGuid.js';
import { addressKey } from '../lib/address.js';
import { ToolError } from '../lib/errors.js';
import type { MessageStore } from './ports.js';
import type { OutgoingAttachment, SendAttachmentResult, SendExtras, SendResult } from './types.js';

/**
 * What an idempotency key promises to repeat: the recipient (group chat_id, or the DM's handle so any service
 * variant of the same thread matches), the trimmed NFC text, the reply target, the effect and each file.
 */
export function sendFingerprint(
  store: Pick<MessageStore, 'chat'>,
  target: { chatId?: string; address?: string },
  text: string,
  attachments: OutgoingAttachment[],
  extras: SendExtras = {},
): string {
  const chat = target.chatId ? store.chat(target.chatId) : undefined;
  const id = chat?.chatId ?? target.chatId ?? '';
  const recipient =
    chat?.type === 'group'
      ? `g:${chatGuidSuffix(id) ?? id}`
      : `d:${addressKey(target.address ?? chatGuidIdentifier(id))}`;
  const files = attachments.map((a) => `${a.filename}:${a.sourceAttachmentId ?? a.base64?.length ?? a.url ?? ''}`);
  const parts = [
    recipient,
    text.trim().normalize('NFC'),
    (extras.replyTo ?? '').replace(/^#/, ''),
    extras.effect ?? '',
    ...files,
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** The key was used before for a different recipient, text or files. Never repeats the earlier text. */
export function idempotencyConflict(
  store?: Pick<MessageStore, 'chat' | 'chatTitle'>,
  prior?: { disposition: string; chatId?: string; messageId?: string | null },
): ToolError {
  const chat = prior?.chatId ? store?.chat(prior.chatId) : undefined;
  const where = prior
    ? ` (${prior.disposition.toUpperCase()}${chat ? ` → ${store!.chatTitle(chat)}` : ''}${prior.messageId ? ` · #${prior.messageId}` : ''})`
    : '';
  return new ToolError(
    'idempotency_conflict',
    `This idempotency_key was already used for a different message${where}. Nothing new was sent.`,
    'Use a new idempotency_key for a new message or a corrected recipient or wording; reuse a key only to retry the exact same message.',
  );
}

/**
 * Sends running right now, by idempotency key: one bridge, any number of senders, and the store's lookup all share it.
 */
export const IN_FLIGHT_SENDS = new Set<string>();

export function inProgressError(): ToolError {
  return new ToolError(
    'in_progress',
    'A send with this idempotency_key is still running.',
    'Wait about 10 seconds, then call again with the same idempotency_key to get its result. Do not switch to a new key.',
  );
}

/** A finished send as the idempotency table keeps it (fp: its sendFingerprint; rows from older installs have none). */
export interface StoredSend {
  disposition: SendResult['disposition'];
  messageId?: string;
  chatId: string;
  error?: SendResult['error'];
  retrySafe: boolean;
  attachments?: SendAttachmentResult[];
  fp?: string;
}

/**
 * Written just before a send reaches Messages and replaced by its StoredSend afterwards. One left over from an earlier
 * run of the bridge (another boot) means the bridge stopped mid-send.
 */
export interface PendingSend {
  pending: true;
  boot: string;
  startedAt: number;
  chatId: string;
  fp: string;
}

export type IdempotencyRow = StoredSend | PendingSend;

export const isPendingSend = (r: IdempotencyRow): r is PendingSend => (r as PendingSend).pending === true;

/** What a pending row from an earlier boot stands for: the send may or may not have gone out, and is never repeated. */
export function interruptedSend(p: PendingSend): StoredSend {
  return {
    disposition: 'may_have_completed',
    chatId: p.chatId,
    retrySafe: false,
    error: {
      code: 'outcome_unknown',
      message: 'The bridge stopped while this message was being sent, so it may or may not have gone out.',
      fix: "Check read_conversation before doing anything else. Don't resend it with a new idempotency_key unless the check shows it is missing and the user agrees.",
    },
    fp: p.fp,
  };
}
