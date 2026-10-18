import * as z from 'zod/v4';
import { ToolError } from '../../lib/errors.js';
import { resolveChat } from '../../lib/resolve.js';
import { onSlot, requireAllowlisted } from '../../policy/sendPolicy.js';
import type { MessageStore } from '../../store/ports.js';
import type { Draft } from '../../store/types.js';
import { defineTool, SENDS } from '../registry.js';
import { jsonResult } from '../results.js';
import { enforceSendPolicy } from './checks.js';
import { CONFIRM_DESC } from './common.js';
import { draftJson, draftTarget, resolveSendAt, scheduledNext } from './drafts.js';
import { sendResult, wentOut } from './results.js';

function getDraft(store: MessageStore, id: string): Draft {
  const d = store.drafts().find((x) => x.draftId === id.trim());
  if (!d)
    throw new ToolError(
      'draft_not_found',
      `No draft has id "${id}".`,
      'Call manage_drafts with action=list to see draft ids.',
    );
  return d;
}

export const manageDrafts = defineTool({
  name: 'manage_drafts',
  tier: 'send',
  title: 'Manage drafts',
  description:
    "List, edit, send now, or delete drafts and scheduled messages. send_now uses send_message's allowlist, kill switch and rate limit but needs no idempotency_key: a draft sends at most once.",
  inputSchema: {
    action: z.enum(['list', 'update', 'send_now', 'delete']),
    draft_id: z.string().optional().describe('Required except for list.'),
    text: z.string().max(20000).optional().describe('update only: the complete new text (replaces the draft).'),
    send_at: z.string().optional().describe('update only. Same formats as create_draft, or "none" to unschedule.'),
    note: z.string().optional().describe('update only: replaces the note; "" clears it.'),
    status: z
      .enum(['pending', 'draft', 'scheduled', 'sent', 'failed', 'all'])
      .default('pending')
      .describe(
        'list filter. pending (default) = drafts and scheduled messages; all includes sent and failed history.',
      ),
    to: z.string().optional().describe('list only: just the drafts to this chat or person.'),
    limit: z.number().int().min(1).max(100).default(20).describe('list only. Default 20.'),
    user_confirmed: z
      .boolean()
      .optional()
      .describe(
        `send_now, or update that schedules or rewords a message, to someone outside the allowlist. ${CONFIRM_DESC}`,
      ),
  },
  annotations: { ...SENDS, destructiveHint: true },
  handler: async (a, ctx) => {
    const { store } = ctx;
    if (a.action === 'list') {
      let all = store
        .drafts()
        .filter(
          (d) =>
            a.status === 'all' ||
            (a.status === 'pending' ? d.status === 'draft' || d.status === 'scheduled' : d.status === a.status),
        );
      if (a.to) {
        const t = resolveChat(store, a.to, true, { strict: true });
        const handles =
          'chat' in t && t.chat.type === 'dm'
            ? new Set(store.person(t.chat.participantIds[0])?.handles.map((h) => h.address) ?? [])
            : new Set<string>();
        all = all.filter((d) =>
          'chat' in t
            ? d.chatId === t.chat.chatId || (!!d.toAddress && handles.has(d.toAddress))
            : d.toAddress === t.newAddress,
        );
      }
      // Failed drafts can still be retried, so the default view says they exist.
      const failed = a.status === 'pending' && !a.to ? store.drafts().filter((d) => d.status === 'failed').length : 0;
      return jsonResult({
        drafts: all.slice(0, a.limit).map((d) => draftJson(store, d)),
        more: all.length > a.limit,
        ...(failed
          ? {
              failed_hidden: failed,
              next: `${failed} failed draft${failed > 1 ? 's are' : ' is'} not shown; list with status=failed to see why, then send_now or update to retry.`,
            }
          : {}),
      });
    }
    if (!a.draft_id)
      throw new ToolError(
        'draft_id_required',
        `action=${a.action} needs draft_id.`,
        'Call manage_drafts with action=list to see draft ids.',
      );
    if (a.action === 'delete') {
      store.deleteDraft(a.draft_id.trim());
      return jsonResult({ deleted: a.draft_id.trim() });
    }
    const d = getDraft(store, a.draft_id);
    if (d.status === 'sent')
      throw new ToolError(
        'already_sent',
        d.sentMessageId ? `That draft was already sent as #${d.sentMessageId}.` : 'That draft was already sent.',
        'Do not send it again. To change it, use edit_message or unsend_message on that id.',
      );
    const t = draftTarget(store, d);
    if (a.action === 'update') {
      if (a.text === undefined && a.send_at === undefined && a.note === undefined)
        throw new ToolError(
          'nothing_to_update',
          'Nothing to change: no text, send_at or note was given.',
          'Call again with the field to change: text (the complete new text), send_at, or note.',
        );
      if (a.text !== undefined && !a.text.trim() && !d.attachments?.length)
        throw new ToolError(
          'empty_message',
          'The new text is empty.',
          'Pass the complete new text. Whitespace-only text counts as empty.',
        );
      const retry = 'call manage_drafts again with action=update, the same draft_id and user_confirmed=true';
      const sched = a.send_at !== undefined ? resolveSendAt(ctx, t, a.send_at, a.user_confirmed, retry) : undefined;
      // Rewording a message that is already scheduled to an unapproved recipient needs approval of the new text.
      if (a.text !== undefined && !sched && d.status === 'scheduled')
        requireAllowlisted(ctx, t, a.user_confirmed, { what: 'rewording this scheduled message', retry });
      const willSchedule = sched ? sched.at !== null : d.status === 'scheduled';
      const confirmed =
        a.user_confirmed && willSchedule ? true : a.text !== undefined || sched?.at === null ? false : undefined;
      const u = store.updateDraft(d.draftId, {
        ...(a.text !== undefined ? { text: a.text } : {}),
        ...(sched ? { sendAt: sched.at } : {}),
        ...(a.note !== undefined ? { note: a.note } : {}),
        ...(confirmed !== undefined ? { confirmed } : {}),
      });
      return jsonResult({
        ...draftJson(store, u),
        ...(sched?.assumed ? { assumed: sched.assumed } : {}),
        next:
          u.status === 'scheduled'
            ? `${scheduledNext(store, u.sendAt!)}${sched?.assumed ? ` ${sched.assumed}` : ''}`
            : 'Saved. Show the user the draft; when they approve, call manage_drafts with action=send_now.',
      });
    }
    if (!d.text.trim() && !d.attachments?.length)
      throw new ToolError(
        'empty_message',
        `Draft ${d.draftId} has no text and no files.`,
        'Add text with manage_drafts action=update, then call send_now again.',
      );
    const seqBefore = store.latestSeq();
    // send_now is interactive, so it asks again: a draft's stored consent is only for the scheduler.
    const release = enforceSendPolicy(ctx, t, a.user_confirmed, 'draft', d.draftId);
    const r = await onSlot(release, () => store.sendDraft(d.draftId), wentOut).catch((e: unknown) => {
      if (e instanceof ToolError && e.code === 'in_progress')
        throw new ToolError(
          'in_progress',
          `Draft ${d.draftId} is being sent right now (by the scheduler or an earlier call).`,
          'Wait about 10 seconds, then check it with manage_drafts action=list status=all. Do not send it again.',
        );
      throw e;
    });
    const status =
      store.drafts().find((x) => x.draftId === d.draftId)?.status ?? (r.disposition === 'failed' ? 'failed' : 'sent');
    return sendResult(ctx, r, {
      seqBefore,
      draft: true,
      targetService: 'chat' in t ? t.chat.service : undefined,
      extra: { draft_id: d.draftId, status },
    });
  },
});
