import * as z from 'zod/v4';
import { senderLabels } from '../../domain/naming.js';
import {
  attachmentFacts,
  chatHeader,
  isMultiBubble,
  linkOf,
  messageJson,
  messageText,
  reactionsText,
  renderLine,
  UNTRUSTED_NOTICE,
} from '../../lib/format.js';
import { foldBreaks, plural } from '../../lib/text.js';
import { fmtIso, fmtShort } from '../../lib/time.js';
import { ME } from '../../store/types.js';
import { findMessage } from '../args.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, renderOpts, textResult } from '../results.js';
import { zFormat } from '../schemas.js';
import { readKit } from './common.js';

export const getMessage = defineTool({
  name: 'get_message',
  tier: 'read',
  title: 'Get one message',
  description: [
    'One message in full: untruncated text, every timestamp (sent, delivered, read, edited), who reacted and how, edit history, link preview, attachments and reply thread.',
    'Set context_before and context_after to see the messages around it.',
    'That is the usual next step after a search hit.',
  ].join(' '),
  inputSchema: {
    message_id: z.string().describe('From any transcript line (#m1234), search result (msg:m1234) or JSON result.'),
    context_before: z.number().int().min(0).max(25).default(0),
    context_after: z.number().int().min(0).max(25).default(0),
    include_edit_history: z.boolean().default(true),
    format: zFormat,
  },
  annotations: READ_ONLY,
  handler: (a, ctx) => {
    const { store, tz, bubbles } = readKit(ctx);
    const m = findMessage(store, a.message_id, { digits: true });
    const chat = store.chat(m.chatId)!;
    const now = store.now();
    const around = store.messagesAround(m.messageId, a.context_before, a.context_after, true);
    const idx = around.findIndex((x) => x.messageId === m.messageId);
    const before = around.slice(0, idx);
    const after = around.slice(idx + 1);
    const replies = store.threadReplies(m.replyToId ?? m.messageId);
    const full = renderOpts(ctx);
    const multi = isMultiBubble(m);
    const showEdits = a.include_edit_history && !m.unsent && !!m.editHistory?.length;
    const base: Record<string, unknown> = messageJson(store, m, full);
    if (m.unsent) delete base.edited_at;
    const detail = {
      ...base,
      chat_title: store.chatTitle(chat),
      reactions: m.reactions.map((r) => ({
        reaction: r.kind === 'emoji' ? r.emoji : r.kind,
        by: r.by === ME ? 'me' : store.personName(r.by),
        at: fmtIso(r.at, tz),
        ...(multi ? { part: r.part ?? 0 } : {}),
      })),
      ...(showEdits
        ? {
            edit_history: m.editHistory!.map((e) => ({
              text: messageText(store, { ...m, text: e.text, unsent: false }, full),
              at: fmtIso(e.at, tz),
            })),
          }
        : {}),
      ...(m.replyToId || replies.length
        ? { thread: { originator_id: m.replyToId ?? m.messageId, reply_count: replies.length } }
        : {}),
    };
    if (a.format === 'json')
      return jsonResult(
        {
          message: detail,
          before: before.map((x) => messageJson(store, x, renderOpts(ctx, 500))),
          after: after.map((x) => messageJson(store, x, renderOpts(ctx, 500))),
        },
        { untrusted: true },
      );
    const labels = senderLabels(store, chat);
    const near = renderOpts(ctx, 500);
    // A multi-line body prints in full once, in the Full text block that keeps its line breaks.
    const multiline = !m.unsent && m.text.includes('\n');
    const out = [chatHeader(store, chat), UNTRUSTED_NOTICE];
    for (const x of before) out.push(renderLine(store, x, labels, near, '    '));
    out.push(
      renderLine(store, m, labels, multiline ? { ...full, maxChars: 280, moreHint: 'full text below' } : full, '  ▶ '),
    );
    for (const x of after) out.push(renderLine(store, x, labels, near, '    '));
    const facts = [`sent ${fmtShort(m.sentAt, tz, now)}`];
    if (m.deliveredAt) facts.push(`delivered ${fmtShort(m.deliveredAt, tz, now)}`);
    if (m.readAt) facts.push(`read ${fmtShort(m.readAt, tz, now)}`);
    if (m.editedAt && !m.unsent) facts.push(`edited ${fmtShort(m.editedAt, tz, now)}`);
    out.push('', `Details · ${facts.join(' · ')} · ${m.service}`);
    if ((m.partCount ?? 0) > 1) out.push(`Bubbles · ${bubbles(m)}`);
    if (m.reactions.length) out.push(`Reactions · ${reactionsText(store, m, labels)}`);
    if (showEdits) {
      const cap = { ...full, maxChars: 280, moreHint: false as const };
      out.push(
        `Edit history · ${[...m.editHistory!.map((e) => messageText(store, { ...m, text: e.text, unsent: false }, cap)), messageText(store, m, cap)].map((t) => `"${foldBreaks(t)}"`).join(' → ')}`,
      );
    }
    const link = m.unsent ? undefined : linkOf(store, m, ctx.cfg.redactCodes);
    if (link) out.push(`Link · ${link.title} · ${link.url}`);
    for (const aid of m.attachmentIds) {
      const at = store.attachment(aid);
      if (at)
        out.push(
          `Attachment · ${attachmentFacts(at)} · attachment_id ${at.attachmentId}${at.kind === 'pdf' || at.kind === 'document' ? ' · text: get_attachment mode=text' : ''}`,
        );
    }
    if (detail.thread) out.push(`Thread · ${plural(replies.length, 'reply', 'replies')} · get_reply_thread for all`);
    if (multiline) out.push('', 'Full text:', messageText(store, m, full));
    return textResult(out.join('\n'));
  },
});
