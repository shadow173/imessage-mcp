// What edit_message and unsend_message may change. The tool layer applies these before anything reaches a store, so
// mock and live refuse the same calls.

import { ToolError } from '../lib/errors.js';
import { MINUTE_MS } from '../lib/units.js';
import { ME, type Message } from '../store/types.js';

/** Apple's limits on changing a sent iMessage. */
export const CHANGE_WINDOWS = { editMs: 15 * MINUTE_MS, unsendMs: 2 * MINUTE_MS, maxEdits: 5 } as const;

export type ChangeKind = 'edit' | 'unsend';

/**
 * Refuses what Messages can never change, whatever the time: a conversation event, someone else's message, an edit of
 * an unsent message, an undelivered message, or SMS. An unsend of an already unsent message passes, so the caller can
 * report it as unchanged.
 */
export function assertChangeable(
  m: Pick<Message, 'system' | 'senderId' | 'unsent' | 'status' | 'service'>,
  what: ChangeKind,
): void {
  const verb = what === 'edit' ? 'edited' : 'unsent';
  if (m.system)
    throw new ToolError(
      'not_a_message',
      `That is a conversation event, not a message, so it can't be ${verb}.`,
      'Pass the message_id of one of your own messages (lines from You).',
    );
  if (m.senderId !== ME)
    throw new ToolError(
      'not_yours',
      `You can only ${what} messages you sent.`,
      "Only the owner's own messages can be changed; check the message_id (lines from You).",
    );
  if (m.unsent && what === 'edit')
    throw new ToolError(
      'unsent',
      "That message was unsent, so it can't be edited.",
      'Send a new message with send_message if the user wants.',
    );
  if (m.unsent) return;
  if (m.status === 'failed')
    throw new ToolError(
      'not_delivered',
      `That message was never delivered, so it can't be ${verb}.`,
      'Send it again with send_message.',
    );
  if (m.service !== 'iMessage')
    throw new ToolError(
      'not_imessage',
      `Only iMessages can be ${verb}, not ${m.service}.`,
      'Send a follow-up correction with send_message instead.',
    );
}

/** Refuses once Apple's edit or unsend window has passed. The window's last millisecond still counts. */
export function assertInWindow(
  m: Pick<Message, 'sentAt' | 'service' | 'editHistory'>,
  what: ChangeKind,
  now: number,
  tz: string,
): void {
  if (now - m.sentAt > (what === 'edit' ? CHANGE_WINDOWS.editMs : CHANGE_WINDOWS.unsendMs))
    throw windowPassedError(what, m, now, tz);
}

/** Refuses an edit past Apple's limit of 5 per message. */
export function assertEditBudget(m: Pick<Message, 'editHistory'>): void {
  if ((m.editHistory?.length ?? 0) >= CHANGE_WINDOWS.maxEdits)
    throw new ToolError(
      'edit_limit',
      'A message can be edited at most 5 times, and this one has been.',
      'Send a follow-up correction with send_message instead.',
    );
}

/** HH:MM, or HH:MM:SS, in tz. */
const clock = (ms: number, tz: string, seconds: boolean) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  }).format(ms);

/** edit_window_passed / unsend_window_passed, with the send time, how long ago, and what can still be done. */
export function windowPassedError(
  what: ChangeKind,
  m: Pick<Message, 'sentAt' | 'service' | 'editHistory'>,
  now: number,
  tz: string,
): ToolError {
  const s = Math.max(0, Math.round((now - m.sentAt) / 1000));
  const ago =
    s >= 3600
      ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`
      : `${Math.floor(s / 60)}m ${s % 60}s ago`;
  const limit = what === 'unsend' ? 'unsent within 2' : 'edited within 15';
  const stillEditable =
    what === 'unsend' &&
    m.service === 'iMessage' &&
    (m.editHistory?.length ?? 0) < CHANGE_WINDOWS.maxEdits &&
    now - m.sentAt < CHANGE_WINDOWS.editMs;
  const fix = stillEditable
    ? `It can still be edited with edit_message until ${clock(m.sentAt + CHANGE_WINDOWS.editMs, tz, false)}, or send a correction with send_message. Ask the user which.`
    : 'Send a correction with send_message after the user approves the wording.';
  return new ToolError(
    `${what}_window_passed`,
    `Sent at ${clock(m.sentAt, tz, true)} (${ago}); messages can only be ${limit} minutes of sending.`,
    fix,
  );
}
