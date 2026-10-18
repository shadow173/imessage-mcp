import * as z from 'zod/v4';
import { EFFECT_ALIASES, EFFECT_NAMES } from '../../domain/effects.js';
import { ToolError } from '../../lib/errors.js';
import { resolveChat } from '../../lib/resolve.js';
import { MINUTE_MS } from '../../lib/units.js';
import type { DraftAttachment } from '../../store/types.js';
import { defineTool, LOCAL_WRITE } from '../registry.js';
import { jsonResult } from '../results.js';
import { zOneOf } from '../schemas.js';
import { prepareAttachments, zAttachment } from './attachments.js';
import { checkRich, paOff, replyTarget } from './checks.js';
import { CONFIRM_DESC, PA_ONLY } from './common.js';
import { draftJson, resolveSendAt, scheduledNext } from './drafts.js';

const zDraftAttachments = z
  .array(zAttachment)
  .optional()
  .describe(
    "Files to send with it: attachment_id (a file already in Messages) or a public https url. Raw base64 can't be kept in a draft.",
  );

export const createDraft = defineTool({
  name: 'create_draft',
  tier: 'send',
  title: 'Create a draft or scheduled message',
  description: [
    'Save a message for the owner to approve, or schedule it with send_at.',
    'Use it when the user wants to see the message before it goes, wants it sent later, or you wrote wording beyond what they asked you to say.',
    'When the user told you what to say ("text Sam that I found his charger"), use send_message; it asks for confirmation itself when needed.',
    "Drafts are saved on the owner's Mac by this connector (not in Messages.app), so the owner sees them only through you; scheduled messages are sent by the Mac while it is awake and the bridge runs, through the same kill switch, allowlist and hourly limit as send_message.",
    'A scheduled message whose time comes while sending is off waits up to an hour, then fails (send_disabled).',
    'Calling it twice with the same message within 10 minutes returns the first draft instead of a duplicate.',
  ].join(' '),
  inputSchema: {
    to: z
      .string()
      .describe(
        'chat_id, group name, or person. Resolved now, so ambiguity shows up early; a partial or loose match fails with candidates.',
      ),
    text: z.string().max(20000).optional().describe('Plain text. May be left out when attachments are given.'),
    attachments: zDraftAttachments,
    send_at: z
      .string()
      .optional()
      .describe(
        "When to send: 30min, 2h, 1d, tomorrow 09:00, or 2026-10-18T09:00 (owner's time zone). Must be in the future; a date alone means 09:00.",
      ),
    note: z.string().optional().describe('Context for the owner reviewing it.'),
    reply_to: z.string().optional().describe(`message_id to reply to inline when it is sent. ${PA_ONLY}`),
    effect: zOneOf(EFFECT_NAMES, EFFECT_ALIASES)
      .optional()
      .describe(`Bubble or screen effect (iMessage only). ${PA_ONLY}`),
    user_confirmed: z
      .boolean()
      .optional()
      .describe(`Needed to schedule (send_at) a message to someone outside the allowlist. ${CONFIRM_DESC}`),
  },
  annotations: { ...LOCAL_WRITE, idempotentHint: false, openWorldHint: true },
  handler: (a, ctx) => {
    const { store } = ctx;
    const pa = ctx.cfg.tiers.has('pa');
    const text = a.text?.trim() ? a.text : '';
    if (!text && !a.attachments?.length)
      throw new ToolError(
        'empty_message',
        'There is nothing to save.',
        'Pass text, attachments, or both. Whitespace-only text counts as empty.',
      );
    if (!pa && (a.reply_to || a.effect)) throw paOff('saved');
    const files = prepareAttachments(ctx, a.attachments ?? [], true);
    let t = resolveChat(store, a.to, true, { strict: true });
    let replyTo: string | undefined;
    if (a.reply_to) ({ t, replyTo } = replyTarget(ctx, t, a.reply_to, 'saved'));
    checkRich(ctx, t, { text, replyTo, effect: a.effect, service: 'auto', verb: 'saved' });
    const sched = a.send_at
      ? resolveSendAt(
          ctx,
          t,
          a.send_at,
          a.user_confirmed,
          'call create_draft again with the same arguments and user_confirmed=true',
        )
      : { at: null };
    const sendAt = sched.at ?? undefined;
    const chatId = 'chat' in t ? t.chat.chatId : null;
    const toAddress = 'chat' in t ? undefined : t.newAddress;
    const attachments: DraftAttachment[] = files.map((f) => ({
      filename: f.filename,
      mime: f.mime,
      ...(f.url ? { url: f.url } : {}),
      ...(f.sourceAttachmentId ? { sourceAttachmentId: f.sourceAttachmentId } : {}),
    }));
    const now = store.now();
    const fileKey = (xs?: DraftAttachment[]) =>
      JSON.stringify((xs ?? []).map((x) => [x.filename, x.url ?? '', x.sourceAttachmentId ?? '']));
    const dup = store
      .drafts()
      .find(
        (d) =>
          (d.status === 'draft' || d.status === 'scheduled') &&
          (d.chatId ?? null) === chatId &&
          (d.toAddress ?? undefined) === toAddress &&
          d.text === text &&
          (d.replyTo ?? '') === (replyTo ?? '') &&
          (d.effect ?? '') === (a.effect ?? '') &&
          fileKey(d.attachments) === fileKey(attachments) &&
          (d.sendAt === undefined) === (sendAt === undefined) &&
          Math.abs((d.sendAt ?? 0) - (sendAt ?? 0)) <= 10 * MINUTE_MS &&
          now - d.createdAt <= 10 * MINUTE_MS,
      );
    if (dup)
      return jsonResult({
        ...draftJson(store, dup),
        deduplicated: true,
        next: `Already saved as ${dup.draftId}; no new draft was created.`,
      });
    // Stored consent is only for the scheduler, which can't ask; send_now asks again.
    const d = store.createDraft({
      chatId,
      toAddress,
      text,
      attachmentNames: [],
      sendAt,
      note: a.note,
      ...(a.user_confirmed && sendAt !== undefined ? { confirmed: true } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(a.effect ? { effect: a.effect } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    return jsonResult({
      ...draftJson(store, d),
      ...(sched.assumed ? { assumed: sched.assumed } : {}),
      next:
        d.status === 'scheduled'
          ? `${scheduledNext(store, d.sendAt!)}${sched.assumed ? ` ${sched.assumed}` : ''}`
          : 'Show the user the draft. When they approve, call manage_drafts with action=send_now.',
    });
  },
});
