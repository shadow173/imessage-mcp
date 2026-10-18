// Checks before anything goes out: where an inline reply goes, what replies and effects need, and the send policy.

import { PRIVATE_API_OFF, ToolError } from '../../lib/errors.js';
import { requireAllowlisted, requireSendEnabled, reserveOutbound, targetLabel } from '../../policy/sendPolicy.js';
import type { ChatTarget, Service } from '../../store/types.js';
import { findMessage } from '../args.js';
import type { Ctx } from '../context.js';

/**
 * An inline reply goes to the message's own chat: the same person's other 1:1 thread is redirected there; anything else
 * is refused.
 */
export function replyTarget(
  ctx: Ctx,
  t: ChatTarget,
  replyToRaw: string,
  verb: 'sent' | 'saved',
): { t: ChatTarget; replyTo: string } {
  const { store } = ctx;
  const orig = findMessage(store, replyToRaw);
  const origChat = store.chat(orig.chatId);
  if (!origChat)
    throw new ToolError(
      'message_not_found',
      `No message has id "${replyToRaw.trim()}".`,
      'Use a message_id from read_conversation or search_messages.',
    );
  if ('chat' in t && t.chat.chatId === origChat.chatId) return { t, replyTo: orig.messageId };
  const samePerson =
    origChat.type === 'dm' &&
    ('chat' in t
      ? t.chat.type === 'dm' && t.chat.participantIds[0] === origChat.participantIds[0]
      : t.person?.personId === origChat.participantIds[0]);
  if (samePerson) return { t: { chat: origChat }, replyTo: orig.messageId };
  const target = targetLabel(ctx, t);
  throw new ToolError(
    'reply_to_wrong_chat',
    `#${orig.messageId} is in ${store.chatTitle(origChat)} (chat_id ${origChat.chatId}), not ${target}. Nothing was ${verb}.`,
    `An inline reply goes to the conversation the message is in. Call again with to="${origChat.chatId}", or drop reply_to to message ${target} separately.`,
  );
}

/** Replies and effects need text and an existing chat; effects need iMessage, replies anything but SMS. */
export function checkRich(
  ctx: Ctx,
  t: ChatTarget,
  o: { text: string; replyTo?: string; effect?: string; service: Service | 'auto'; verb: 'sent' | 'saved' },
) {
  if (!o.replyTo && !o.effect) return;
  const what = o.replyTo && o.effect ? 'Inline replies and effects' : o.replyTo ? 'Inline replies' : 'Effects';
  if (!o.text.trim())
    throw new ToolError(
      'needs_text',
      `${what} need text. Nothing was ${o.verb}.`,
      'Add text, or drop reply_to/effect and send the attachment on its own.',
    );
  if (!('chat' in t))
    throw new ToolError(
      'needs_existing_chat',
      `${what} need an existing conversation, and there is none with ${targetLabel(ctx, t)} yet. Nothing was ${o.verb}.`,
      'Send a plain message first (drop reply_to and effect), then try again.',
    );
  const svc = t.chat.type === 'group' || o.service === 'auto' ? t.chat.service : o.service;
  const label = targetLabel(ctx, t);
  // The reply stays in the message's own thread, so an explicit other service can't apply (send_message skips the
  // service swap for replies).
  if (o.replyTo && svc !== t.chat.service) {
    throw new ToolError(
      'reply_to_wrong_chat',
      `#${o.replyTo} is in the ${t.chat.service} conversation with ${label} (chat_id ${t.chat.chatId}), so an inline reply goes there, not over ${svc}. Nothing was ${o.verb}.`,
      t.chat.service === 'SMS'
        ? `SMS has no inline replies: call again without reply_to (quote the message in the text if the context matters), keeping service=${svc === 'iMessage' ? 'imessage' : 'sms'} if you want that service.`
        : 'Drop service to reply in that conversation, or drop reply_to to send on the other service.',
    );
  }
  if (o.effect && svc !== 'iMessage')
    throw new ToolError(
      'not_imessage',
      `Effects only work in iMessage; ${label} is ${svc === 'RCS' ? 'an RCS' : 'an SMS'} conversation. Nothing was ${o.verb}.`,
      'Call again without effect (the same idempotency_key is fine).',
    );
  if (o.replyTo && svc === 'SMS')
    throw new ToolError(
      'not_imessage',
      `Inline replies only work in iMessage and RCS; ${label} is an SMS conversation. Nothing was ${o.verb}.`,
      'Call again without reply_to; quote the message in the text if the context matters.',
    );
  if (svc !== t.chat.service)
    throw new ToolError(
      'needs_existing_chat',
      `There is no ${svc} conversation with ${label} yet, and ${what.toLowerCase()} need one. Nothing was ${o.verb}.`,
      "Drop service (the conversation's own service is used), or send a plain message first.",
    );
}

/**
 * The send policy for send_message (via 'send_message') and manage_drafts send_now (via 'draft'): kill switch,
 * allowlist with confirmation, hourly limit. Returns the reserved slot's release; run the send with onSlot.
 */
export function enforceSendPolicy(
  ctx: Ctx,
  t: ChatTarget,
  userConfirmed: boolean | undefined,
  via: 'send_message' | 'draft' = 'send_message',
  draftId?: string,
): () => void {
  if (via === 'draft') {
    const d = draftId ? `Draft ${draftId}` : 'The draft';
    requireSendEnabled(ctx, {
      fix: `Tell the user. ${d} is kept; once the owner enables sending, call manage_drafts send_now with this draft_id again.`,
    });
    requireAllowlisted(ctx, t, userConfirmed, {
      retry: 'call manage_drafts again with action=send_now, the same draft_id and user_confirmed=true',
    });
    return reserveOutbound(ctx, {
      fix: 'The draft is kept; call send_now again later, or schedule it with manage_drafts update send_at.',
    });
  }
  requireSendEnabled(ctx, {
    fix: 'Tell the user. The owner can enable it with SEND_ENABLED=true in the bridge config. You can still save the text (not raw files) with create_draft.',
  });
  requireAllowlisted(ctx, t, userConfirmed);
  return reserveOutbound(ctx, { fix: 'Tell the user, or save the text (not raw files) with create_draft for later.' });
}

export const paOff = (verb: 'sent' | 'saved') =>
  new ToolError(
    PRIVATE_API_OFF.code,
    `Inline replies and effects need the Private API, which is off on this Mac. Nothing was ${verb}.`,
    `Ask the user whether to ${verb === 'sent' ? 'send' : 'save'} it as a plain message; if yes, call again without reply_to and effect${verb === 'sent' ? ' (the same idempotency_key is fine)' : ''}.`,
  );
