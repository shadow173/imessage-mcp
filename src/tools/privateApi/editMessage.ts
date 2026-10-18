import * as z from 'zod/v4';
import { ToolError } from '../../lib/errors.js';
import { clip, oneLine } from '../../lib/text.js';
import { fmtClock, fmtIso } from '../../lib/time.js';
import { assertChangeable, assertEditBudget, assertInWindow, CHANGE_WINDOWS } from '../../policy/messageChanges.js';
import { redact } from '../../policy/redact.js';
import { onSlot, requireListed, requireSendEnabled, reserveOutbound } from '../../policy/sendPolicy.js';
import { findMessage } from '../args.js';
import { defineTool, SENDS } from '../registry.js';
import { privateApiKit, RATE_FIX, SEND_OFF_FIX, UNCONFIRMED } from './common.js';

export const editMessage = defineTool({
  name: 'edit_message',
  tier: 'pa',
  title: 'Edit a sent message',
  description: [
    'Edit one of your own sent iMessages, within 15 minutes of sending.',
    'Up to 5 edits.',
    'Recipients see the edit history.',
    'If the result says NOT CONFIRMED YET, check with get_message instead of retrying.',
  ].join(' '),
  inputSchema: {
    message_id: z
      .string()
      .describe('One of your own messages: #m1234 or msg:m1234 from a transcript or search result.'),
    text: z
      .string()
      .describe(
        'The complete new text. It replaces the whole message, so to add or fix something pass the full corrected message, not just the change.',
      ),
  },
  annotations: SENDS,
  handler: async (a, ctx) => {
    const { store, tz, line, titleOf, result } = privateApiKit(ctx);
    const m = findMessage(store, a.message_id);
    const text = a.text.trim();
    if (!text)
      throw new ToolError(
        'empty_message',
        'The new text is empty.',
        'Pass the complete corrected message. To take a message back, use unsend_message (within 2 minutes of sending).',
      );
    requireSendEnabled(ctx, { fix: SEND_OFF_FIX });
    assertChangeable(m, 'edit');
    const editsBefore = m.editHistory?.length ?? 0;
    const head = `${titleOf(m)} · chat_id ${m.chatId}`;
    const base = { message_id: m.messageId, chat_id: m.chatId, retry_safe: false };
    if (m.text === text) {
      return result(
        `No change: the message already says this, so no edit was sent and none of the 5 edits was used.\n${line(m)}`,
        { ...base, status: 'unchanged', edits_left: CHANGE_WINDOWS.maxEdits - editsBefore },
      );
    }
    assertInWindow(m, 'edit', store.now(), tz);
    assertEditBudget(m);
    requireListed(ctx, { chat: store.chat(m.chatId)! }, 'editing this message');
    const release = reserveOutbound(ctx, { fix: RATE_FIX });
    const prevText = m.text,
      prevEditedAt = m.editedAt;
    const out = await onSlot(release, () => store.edit(m.messageId, text));
    const confirmed = out.text.trim() === text || (!!out.editedAt && out.editedAt !== prevEditedAt);
    const n = Math.max(out.editHistory?.length ?? 0, editsBefore + 1);
    const until = m.sentAt + CHANGE_WINDOWS.editMs;
    const was = clip(oneLine(redact(prevText, undefined, ctx.cfg.redactCodes)).trim(), 200);
    const headline = confirmed
      ? `EDITED → ${head} · edit ${n} of 5 · ${n >= CHANGE_WINDOWS.maxEdits ? 'no edits left' : `editable until ${fmtClock(until, tz)}`}\nwas: "${was}"`
      : `NOT CONFIRMED YET → ${head}\n${UNCONFIRMED} A repeated edit adds another entry to the history recipients see.`;
    return result(`${headline}\n${line(out)}`, {
      ...base,
      status: confirmed ? 'edited' : 'unconfirmed',
      edits_left: Math.max(0, CHANGE_WINDOWS.maxEdits - (confirmed ? n : editsBefore)),
      editable_until: fmtIso(until, tz),
    });
  },
});
