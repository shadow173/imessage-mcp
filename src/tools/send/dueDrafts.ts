// Scheduled drafts: due drafts go through the same policy as send_now. services/draftScheduler.ts runs this on a
// timer on the bridge and in the gateway's mock mode.

import { ToolError } from '../../lib/errors.js';
import { HOUR_MS } from '../../lib/units.js';
import { onSlot, requireAllowlisted, requireSendEnabled, reserveOutbound } from '../../policy/sendPolicy.js';
import type { MessageStore } from '../../store/ports.js';
import type { Draft } from '../../store/types.js';
import type { Ctx } from '../context.js';
import { draftTarget } from './drafts.js';
import { wentOut } from './results.js';

const running = new WeakSet<MessageStore>();

/**
 * Errors that may clear up by the next tick: the draft stays scheduled (within the grace window). The kill switch holds
 * it too.
 */
const TRANSIENT = new Set([
  'in_progress',
  'rate_limited',
  'busy',
  'private_api_unavailable',
  'outcome_unknown',
  'send_disabled',
]);

export interface ScheduledOutcome {
  draftId: string;
  outcome: string;
}

/**
 * Sends every scheduled draft that is due. Overdue by more than graceMs -> missed_window. Returns what happened to
 * each.
 */
export async function runDueDrafts(ctx: Ctx, graceMs = HOUR_MS): Promise<ScheduledOutcome[]> {
  const { store } = ctx;
  if (running.has(store)) return [];
  running.add(store);
  const out: ScheduledOutcome[] = [];
  const fail = (d: Draft, code: string) => {
    try {
      store.markDraftFailed(d.draftId, code);
    } catch {
      /* sent or deleted meanwhile */
    }
    out.push({ draftId: d.draftId, outcome: `failed:${code}` });
  };
  try {
    const now = store.now();
    for (const d of store
      .drafts()
      .filter((x) => x.status === 'scheduled' && x.sendAt !== undefined && x.sendAt <= now)) {
      if (now - d.sendAt! > graceMs) {
        fail(d, ctx.cfg.sendEnabled ? 'missed_window' : 'send_disabled');
        continue;
      }
      try {
        const t = draftTarget(store, d);
        requireSendEnabled(ctx);
        requireAllowlisted(ctx, t, d.confirmed, { context: false });
        const r = await onSlot(reserveOutbound(ctx), () => store.sendDraft(d.draftId), wentOut);
        out.push({ draftId: d.draftId, outcome: r.disposition });
      } catch (e) {
        if (e instanceof ToolError && TRANSIENT.has(e.code)) {
          out.push({ draftId: d.draftId, outcome: `kept:${e.code}` });
          continue;
        }
        if (!(e instanceof ToolError)) console.error(`[scheduler] draft ${d.draftId}:`, e);
        fail(d, e instanceof ToolError ? e.code : 'internal_error');
      }
    }
  } finally {
    running.delete(store);
  }
  for (const o of out) console.log(`[scheduler] draft ${o.draftId}: ${o.outcome}`);
  return out;
}
