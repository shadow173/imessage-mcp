import * as z from 'zod/v4';
import { assertChangeable, assertInWindow } from '../../policy/messageChanges.js';
import { findMessage } from '../args.js';
import { defineTool, SENDS } from '../registry.js';
import { privateApiKit, UNCONFIRMED } from './common.js';

export const unsendMessage = defineTool({
  name: 'unsend_message',
  tier: 'pa',
  title: 'Unsend a message',
  description: [
    'Unsend one of your own iMessages, within 2 minutes of sending.',
    'Recipients on older software may still see it.',
    'Works even when sending is turned off.',
    'If the result says NOT CONFIRMED YET, check with get_message instead of retrying.',
  ].join(' '),
  inputSchema: {
    message_id: z
      .string()
      .describe('One of your own messages: #m1234 or msg:m1234 from a transcript or search result.'),
  },
  annotations: { ...SENDS, destructiveHint: true },
  handler: async (a, ctx) => {
    const { store, tz, line, titleOf, result } = privateApiKit(ctx);
    const m = findMessage(store, a.message_id);
    assertChangeable(m, 'unsend');
    const head = `${titleOf(m)} · chat_id ${m.chatId}`;
    const base = { message_id: m.messageId, chat_id: m.chatId, retry_safe: false };
    if (m.unsent) return result(`Already unsent; nothing was sent.\n${line(m)}`, { ...base, status: 'unchanged' });
    assertInWindow(m, 'unsend', store.now(), tz);
    const out = await store.unsend(m.messageId);
    const confirmed = !!out.unsent;
    return result(`${confirmed ? `UNSENT → ${head}` : `NOT CONFIRMED YET → ${head}\n${UNCONFIRMED}`}\n${line(out)}`, {
      ...base,
      status: confirmed ? 'unsent' : 'unconfirmed',
    });
  },
});
