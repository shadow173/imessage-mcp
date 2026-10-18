import * as z from 'zod/v4';
import { SCOPES } from '../../auth/scopes.js';
import { ToolError } from '../../lib/errors.js';
import { requireChat } from '../../lib/resolve.js';
import { requireSendEnabled } from '../../policy/sendPolicy.js';
import type { Chat } from '../../store/types.js';
import { defineTool, SENDS } from '../registry.js';
import { jsonResult } from '../results.js';
import { zChatOpt, zChats } from '../schemas.js';
import { SEND_OFF_FIX } from './common.js';

/** mark_read on several chats stops at these: the rest would hit the same wall. */
const STOP_CODES = new Set([
  'busy',
  'outcome_unknown',
  'private_api_unavailable',
  'requires_private_api',
  'send_disabled',
]);

export const markRead = defineTool({
  name: 'mark_read',
  tier: 'pa',
  title: 'Mark read or unread',
  description: [
    'Mark a conversation read (sends read receipts if the owner has them on; needs Send as you) or unread (nothing is sent; Organize is enough).',
    'Marking an iMessage/RCS chat read can send a read receipt; SMS never sends receipts.',
    "Don't mark unknown senders read unless the user asked. changed is 0 when the chat was already in that state; unread=true flags only the latest incoming message.",
    'To clear several at once, pass chats with chat_ids from catch_up or list_conversations.',
  ].join(' '),
  inputSchema: { chat: zChatOpt, chats: zChats, unread: z.boolean().default(false) },
  annotations: { ...SENDS, idempotentHint: true },
  scopeFor: (a) => (a.unread ? SCOPES.organize : SCOPES.send),
  scopeHint: (a, c) =>
    !a.unread && c.scopes.has(SCOPES.organize)
      ? 'Marking read sends read receipts. To flag the chat for later without this permission, call mark_read with unread=true, or use label_conversation or set_reminder.'
      : undefined,
  handler: async (a, ctx) => {
    const { store } = ctx;
    if (!a.chat === !a.chats)
      throw new ToolError(
        'chat_required',
        a.chat ? 'Pass chat or chats, not both.' : 'Pass chat, or chats for several at once.',
        'Use the chat_ids catch_up or list_conversations showed.',
      );
    if (!a.unread) requireSendEnabled(ctx, { fix: SEND_OFF_FIX });
    const now = a.unread ? 'unread' : 'read';
    if (a.chat) {
      const c = requireChat(store, a.chat);
      const needsReply = store.summarizeChat(c.chatId).needsReply;
      const n = await store.markRead(c.chatId, a.unread);
      return jsonResult({ chat_id: c.chatId, title: store.chatTitle(c), changed: n, now, needs_reply: needsReply });
    }
    // Resolve every entry before any write: one ambiguous name must not leave the batch half done.
    const chats: Chat[] = [];
    a.chats!.forEach((input, i) => {
      let c: Chat;
      try {
        c = requireChat(store, input);
      } catch (e) {
        if (e instanceof ToolError) e.message = `chats[${i}] "${input}": ${e.message} Nothing was marked.`;
        throw e;
      }
      if (!chats.some((x) => x.chatId === c.chatId)) chats.push(c);
    });
    const results: { chat_id: string; title: string; changed: number; needs_reply: boolean }[] = [];
    const failed: { chat_id: string; title: string; error: string; message: string }[] = [];
    let stopped = -1;
    for (const [i, c] of chats.entries()) {
      const needsReply = store.summarizeChat(c.chatId).needsReply;
      try {
        results.push({
          chat_id: c.chatId,
          title: store.chatTitle(c),
          changed: await store.markRead(c.chatId, a.unread),
          needs_reply: needsReply,
        });
      } catch (e) {
        const te = e instanceof ToolError ? e : undefined;
        if (!te) console.error('[mark_read]', e);
        failed.push({
          chat_id: c.chatId,
          title: store.chatTitle(c),
          error: te?.code ?? 'internal_error',
          message: te?.message ?? 'Something went wrong on the server.',
        });
        if (!te || STOP_CODES.has(te.code)) {
          stopped = i;
          break;
        }
      }
    }
    const notAttempted =
      stopped < 0 ? [] : chats.slice(stopped + 1).map((c) => ({ chat_id: c.chatId, title: store.chatTitle(c) }));
    return jsonResult({
      now,
      results,
      failed,
      not_attempted: notAttempted,
      total_changed: results.reduce((s, r) => s + r.changed, 0),
    });
  },
});
