import * as z from 'zod/v4';
import { ToolError } from '../../lib/errors.js';
import { requireChat } from '../../lib/resolve.js';
import type { Chat } from '../../store/types.js';
import { defineTool, LOCAL_WRITE } from '../registry.js';
import { jsonResult } from '../results.js';
import { zChatOpt, zChats } from '../schemas.js';

export const labelConversation = defineTool({
  name: 'label_conversation',
  tier: 'org',
  title: 'Label a conversation',
  description: [
    'Add or remove labels on a conversation, like Gmail labels, then filter (or check) list_conversations and catch_up with label=<name>.',
    'A label is created on first use.',
    'Pass chats to label several at once.',
    'Call it with no chat to list every label and its count.',
  ].join(' '),
  inputSchema: {
    chat: zChatOpt,
    chats: zChats,
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
  },
  annotations: LOCAL_WRITE,
  handler: (a, ctx) => {
    const { store } = ctx;
    if (a.chat && a.chats)
      throw new ToolError(
        'chat_required',
        'Pass chat, or chats for several at once, not both. Nothing was labelled.',
        'Put every conversation in chats.',
      );
    if (!a.chat && !a.chats) return jsonResult({ labels: store.labelCounts() });
    if (a.chat) {
      const c = requireChat(store, a.chat, { strict: true });
      const updated = store.labelChat(c.chatId, a.add ?? [], a.remove ?? []);
      return jsonResult({ chat_id: updated.chatId, title: store.chatTitle(updated), labels: updated.labels });
    }
    // Resolve every entry before writing: one ambiguous or unknown name labels nothing.
    const targets = new Map<string, Chat>();
    for (const x of a.chats!) {
      try {
        const c = requireChat(store, x, { strict: true });
        targets.set(c.chatId, c);
      } catch (e) {
        if (e instanceof ToolError)
          throw new ToolError(e.code, `${e.message} Nothing was labelled.`, e.fix, e.candidates);
        throw e;
      }
    }
    const results = [...targets.values()].map((c) => {
      const updated = store.labelChat(c.chatId, a.add ?? [], a.remove ?? []);
      return { chat_id: updated.chatId, title: store.chatTitle(updated), labels: updated.labels };
    });
    return jsonResult({ results });
  },
});
