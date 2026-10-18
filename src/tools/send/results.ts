// What a send returns: the text block, the structured payload and the updates cursor.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { chatGuidIdentifier } from '../../domain/chatGuid.js';
import { senderLabels } from '../../domain/naming.js';
import { prettyAddress } from '../../lib/address.js';
import { encodeCursor } from '../../lib/cursor.js';
import { renderLine } from '../../lib/format.js';
import { fmtIso } from '../../lib/time.js';
import { CHANGE_WINDOWS } from '../../policy/messageChanges.js';
import type { MessageStore } from '../../store/ports.js';
import type { SendResult, Service } from '../../store/types.js';
import type { Ctx } from '../context.js';
import { renderOpts } from '../results.js';

/** A send that used up a rate-limit slot: something went out and it wasn't a replay. */
export const wentOut = (r: SendResult) => r.disposition !== 'failed' && !r.replayed;

export interface SendTextOpts {
  /** The result of manage_drafts send_now (retry advice differs: the draft is kept). */
  draft?: boolean;
  /** The service of the chat the agent addressed; the header says "via SMS" when the send used another. */
  targetService?: Service;
  /** The updates cursor to print (sendResult computes it). */
  cursor?: string | null;
  /** Extra lines after the result (a reminder this send cleared). */
  notes?: string[];
}

function retryLine(r: SendResult, draft?: boolean): string {
  if (r.disposition === 'delivered' || r.disposition === 'sent')
    return r.error
      ? 'retry_safe: false (part of it went out; follow the Fix, never resend the whole message)'
      : 'retry_safe: false (it went out; do not resend)';
  if (r.disposition === 'still_in_flight') return 'retry_safe: false (Messages has it queued; do not resend)';
  if (r.disposition === 'may_have_completed') {
    return /^attachment_/.test(r.error?.code ?? '')
      ? 'retry_safe: false (part of it went out; follow the Fix, never resend the whole message)'
      : 'retry_safe: false (outcome unknown: check read_conversation first; never resend with a new key)';
  }
  if (r.retrySafe)
    return draft
      ? 'retry_safe: true (nothing was delivered; the draft is kept; manage_drafts send_now retries it)'
      : 'retry_safe: true (nothing was delivered; call again with the same idempotency_key to retry)';
  return `retry_safe: false (${r.error?.fix ? 'see Fix' : 'check read_conversation before trying again'})`;
}

const resultService = (store: MessageStore, r: SendResult): Service | null =>
  r.message?.service ?? store.chat(r.chatId)?.service ?? null;

/**
 * The text block of a send result. Never assumes the chat exists: a first message to a new number may not have one yet.
 */
export function sendResultText(ctx: Ctx, r: SendResult, opts: SendTextOpts = {}): string {
  const { store } = ctx;
  const chat = store.chat(r.chatId);
  const svc = resultService(store, r);
  const via = opts.targetService && svc && svc !== opts.targetService ? ` · via ${svc}` : '';
  const head = chat
    ? `${store.chatTitle(chat)} · chat_id ${r.chatId}`
    : `${prettyAddress(chatGuidIdentifier(r.chatId))} (no conversation yet) · chat_id ${r.chatId}`;
  const lines = [`${r.disposition.toUpperCase()} → ${head}${via}`];
  const labels = chat ? senderLabels(store, chat) : undefined;
  if (r.message && labels) lines.push(renderLine(store, r.message, labels, renderOpts(ctx)));
  for (const f of r.attachments ?? []) {
    if (f.messageId && f.messageId === r.message?.messageId) continue;
    const m = f.messageId ? store.message(f.messageId) : undefined;
    lines.push(
      m && labels && f.status !== 'failed'
        ? renderLine(store, m, labels, renderOpts(ctx))
        : `${f.status === 'failed' ? '✗' : '?'} ${f.filename}: ${f.status === 'failed' ? `not sent${f.error ? ` (${f.error})` : ''}` : 'unconfirmed'}`,
    );
  }
  if (r.error) lines.push(`Error ${r.error.code}: ${r.error.message}`);
  if (r.error?.fix) lines.push(`Fix: ${r.error.fix}`);
  lines.push(retryLine(r, opts.draft));
  if (r.replayed) lines.push('replayed: this idempotency_key already sent it; nothing new went out');
  lines.push(...(opts.notes ?? []));
  if (opts.cursor) lines.push(`updates_cursor ${opts.cursor} (pass to get_updates to wait for the reply)`);
  return lines.join('\n');
}

/**
 * An 'up' cursor just past this send's own new/delivered events, so get_updates shows only what comes after it. null
 * when it failed.
 */
function updatesCursor(store: MessageStore, seqBefore: number, r: SendResult): string | null {
  if (r.disposition === 'failed') return null;
  const own = new Set([r.message?.messageId, ...(r.attachments ?? []).map((f) => f.messageId)].filter(Boolean));
  let s = seqBefore;
  for (const e of store.updatesSince(seqBefore)) {
    if ((e.type === 'new' || e.type === 'delivered') && own.has(e.messageId)) s = e.seq;
    else break;
  }
  return encodeCursor({ k: 'up', s, b: store.bootId, t: store.now() });
}

/** structuredContent shared by send_message and manage_drafts send_now. */
export function sendPayload(ctx: Ctx, r: SendResult, opts: { cursor?: string | null } = {}) {
  const { store } = ctx;
  const tz = store.timeZone;
  const m = r.message;
  const changeable = !!m && r.disposition !== 'failed' && m.service === 'iMessage' && ctx.cfg.tiers.has('pa');
  return {
    disposition: r.disposition,
    message_id: m?.messageId ?? null,
    chat_id: r.chatId,
    retry_safe: r.retrySafe,
    error: r.error ?? null,
    service: resultService(store, r),
    replayed: !!r.replayed,
    sent_at: m ? fmtIso(m.sentAt, tz) : null,
    ...(changeable
      ? {
          edit_until: fmtIso(m.sentAt + CHANGE_WINDOWS.editMs, tz),
          unsend_until: fmtIso(m.sentAt + CHANGE_WINDOWS.unsendMs, tz),
        }
      : {}),
    updates_cursor: opts.cursor ?? null,
    ...(r.attachments
      ? {
          attachments_sent: r.attachments.map((f) => ({
            filename: f.filename,
            message_id: f.messageId,
            status: f.status,
          })),
        }
      : {}),
  };
}

/** The tool result for a send: isError only when nothing went out (disposition failed). */
export function sendResult(
  ctx: Ctx,
  r: SendResult,
  opts: SendTextOpts & { seqBefore?: number; extra?: Record<string, unknown> } = {},
): CallToolResult {
  const cursor = opts.seqBefore === undefined ? null : updatesCursor(ctx.store, opts.seqBefore, r);
  return {
    content: [{ type: 'text', text: sendResultText(ctx, r, { ...opts, cursor }) }],
    structuredContent: { ...opts.extra, ...sendPayload(ctx, r, { cursor }) },
    ...(r.disposition === 'failed' ? { isError: true } : {}),
  };
}
