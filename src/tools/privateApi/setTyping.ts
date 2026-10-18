import * as z from 'zod/v4';
import { requireChat } from '../../lib/resolve.js';
import { requireSendEnabled } from '../../policy/sendPolicy.js';
import { defineTool, SENDS } from '../registry.js';
import { jsonResult } from '../results.js';
import { zChatReq } from '../schemas.js';
import { SEND_OFF_FIX } from './common.js';

export const setTyping = defineTool({
  name: 'set_typing',
  tier: 'pa',
  title: 'Typing indicator',
  description: 'Show or stop the typing indicator in a chat. It clears by itself after a short while.',
  inputSchema: { chat: zChatReq, typing: z.boolean().default(true) },
  annotations: SENDS,
  handler: async (a, ctx) => {
    const { store } = ctx;
    requireSendEnabled(ctx, { fix: SEND_OFF_FIX });
    const c = requireChat(store, a.chat);
    await store.setTyping(c.chatId, a.typing);
    return jsonResult({ chat_id: c.chatId, title: store.chatTitle(c), typing: a.typing });
  },
});
