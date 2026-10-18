// What create_draft and manage_drafts share: a draft's target, its JSON shape, and send_at.

import { chatGuidIdentifier } from '../../domain/chatGuid.js';
import { addressKey, prettyAddress } from '../../lib/address.js';
import { ToolError } from '../../lib/errors.js';
import { matchPeople } from '../../lib/resolve.js';
import { fmtDueIn, fmtIso, fmtShort, parseFutureTime } from '../../lib/time.js';
import { requireAllowlisted } from '../../policy/sendPolicy.js';
import type { MessageStore } from '../../store/ports.js';
import type { ChatTarget, Draft } from '../../store/types.js';
import type { Ctx } from '../context.js';

export function draftTarget(store: MessageStore, d: Draft): ChatTarget {
  if (d.chatId) {
    const chat = store.chat(d.chatId);
    if (!chat)
      throw new ToolError(
        'chat_not_found',
        `Draft ${d.draftId}'s conversation (chat_id ${d.chatId}) is no longer visible.`,
        'Delete the draft, or create a new one to the right recipient.',
      );
    return { chat };
  }
  return { newAddress: d.toAddress ?? '' };
}

/**
 * The contact's name for a new-conversation draft, so the result shows who was picked; the number when it's nobody
 * known.
 */
function addressTitle(store: MessageStore, address: string): string {
  const p = matchPeople(store, address).find(
    (h) => h.score >= 3 && h.item.handles.some((x) => addressKey(x.address) === addressKey(address)),
  )?.item;
  return p ? store.personName(p.personId) : prettyAddress(address);
}

export function draftJson(store: MessageStore, d: Draft) {
  const chat = d.chatId ? store.chat(d.chatId) : undefined;
  return {
    draft_id: d.draftId,
    status: d.status,
    to: d.chatId
      ? { chat_id: d.chatId, title: chat ? store.chatTitle(chat) : prettyAddress(chatGuidIdentifier(d.chatId)) }
      : { address: d.toAddress, title: addressTitle(store, d.toAddress ?? '') },
    text: d.text,
    send_at: d.sendAt ? fmtIso(d.sendAt, store.timeZone) : null,
    note: d.note ?? null,
    ...(d.attachments?.length
      ? { attachments: d.attachments.map((a) => ({ filename: a.filename, mime_type: a.mime })) }
      : {}),
    ...(d.replyTo ? { reply_to: d.replyTo } : {}),
    ...(d.effect ? { effect: d.effect } : {}),
    ...(d.error ? { error: d.error } : {}),
    created_at: fmtIso(d.createdAt, store.timeZone),
    sent_message_id: d.sentMessageId ?? null,
  };
}

/**
 * send_at for create_draft and manage_drafts update: a future time, gated by the kill switch and the allowlist now
 * rather than at send time.
 */
export function resolveSendAt(
  ctx: Ctx,
  t: ChatTarget,
  input: string,
  userConfirmed: boolean | undefined,
  retry: string,
): { at: number | null; assumed?: string } {
  const { store } = ctx;
  if (/^(none|null|never|unschedule)$/i.test(input.trim())) return { at: null };
  const r = parseFutureTime(input, store.timeZone, store.now(), 'send_at');
  if (!ctx.cfg.sendEnabled)
    throw new ToolError(
      'send_disabled',
      "Sending is turned off on the Mac, so this can't be scheduled.",
      'Tell the user. Save it without send_at; the owner can send it with manage_drafts send_now once sending is on.',
    );
  requireAllowlisted(ctx, t, userConfirmed, { what: 'scheduling this message', retry });
  return { at: r.at, ...(r.assumed ? { assumed: r.assumed } : {}) };
}

export const scheduledNext = (store: MessageStore, at: number) =>
  `Scheduled for ${fmtShort(at, store.timeZone, store.now())} (${fmtDueIn(at, store.now())}). The Mac sends it then if it's awake and sending is on; it waits up to an hour for either, then is marked failed (missed_window, or send_disabled if sending stayed off). manage_drafts can change or cancel it.`;
