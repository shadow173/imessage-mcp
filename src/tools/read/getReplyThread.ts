import * as z from 'zod/v4';
import { senderLabels } from '../../domain/naming.js';
import { decodeCursor, encodeCursor, zOffset } from '../../lib/cursor.js';
import { ToolError } from '../../lib/errors.js';
import { chatHeader, messageJson, renderLine, UNTRUSTED_NOTICE } from '../../lib/format.js';
import { findMessage } from '../args.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, offsetPage, renderOpts, textResult } from '../results.js';
import { zCursor, zFormat, zLimit } from '../schemas.js';
import { zId } from './common.js';

/** get_reply_thread: next offset and the thread's originator. */
const RtCursor = z.object({ k: z.literal('rt'), o: zOffset, id: zId.optional() });

export const getReplyThread = defineTool({
  name: 'get_reply_thread',
  tier: 'read',
  title: 'Read a reply thread',
  description:
    'Read an inline reply thread. Pass any message in the thread to get the original and every reply in order.',
  inputSchema: {
    message_id: z.string().describe('Any message in the thread: #m1234, msg:m1234 or m1234.'),
    limit: zLimit(100, 500),
    cursor: zCursor,
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store } = ctx;
    const m = findMessage(store, a.message_id, { digits: true });
    const originatorId = m.replyToId ?? m.messageId;
    const orig = store.message(originatorId);
    const replies = store.threadReplies(originatorId);
    let offset = 0;
    if (a.cursor) {
      const c = decodeCursor(a.cursor, RtCursor);
      if (c.id !== undefined && c.id !== originatorId)
        throw new ToolError(
          'invalid_cursor',
          'That cursor belongs to a different thread.',
          'Pass the message_id the cursor came from, or omit cursor to start from the first reply.',
        );
      offset = c.o;
    }
    const { page, next } = offsetPage(replies, a.limit, offset);
    const nextCursor = next !== undefined ? encodeCursor({ k: 'rt', o: next, id: originatorId }) : null;
    if (a.format === 'json')
      return jsonResult(
        {
          originator: orig ? messageJson(store, orig, renderOpts(ctx)) : null,
          reply_count: replies.length,
          replies: page.map((r) => messageJson(store, r, renderOpts(ctx))),
          next_cursor: nextCursor,
        },
        { untrusted: true },
      );
    const chat = store.chat(m.chatId)!;
    const labels = senderLabels(store, chat);
    const out = [
      chatHeader(store, chat),
      UNTRUSTED_NOTICE,
      orig
        ? renderLine(store, orig, labels, renderOpts(ctx))
        : `(the original message #${originatorId} is not available)`,
      ...page.map((r) => renderLine(store, { ...r, replyToId: undefined }, labels, renderOpts(ctx), '   ↳ ')),
    ];
    if (!replies.length) out.push('   (no replies)');
    if (nextCursor) out.push(`more → cursor ${nextCursor}`);
    return textResult(out.join('\n'));
  },
});
