import type { MessageStore } from '../store/ports.js';
import type { Ctx } from '../tools/context.js';
import { runDueDrafts } from '../tools/send/dueDrafts.js';

const TICK_MS = 15_000;
const schedulers = new WeakMap<MessageStore, NodeJS.Timeout>();

/**
 * Sends scheduled drafts as they come due: a tick now and every 15 s, once per store, and only where the send tier is
 * on. The bridge starts it, and so does the gateway in mock mode; registering the tools never does. ctx.sendLog should
 * be the one the tools use, so scheduled sends count toward the same hourly limit.
 */
export function startDraftScheduler(ctx: Ctx): void {
  if (!ctx.cfg.tiers.has('send') || schedulers.has(ctx.store)) return;
  const tick = () => {
    runDueDrafts(ctx).catch((e) => console.error('[scheduler]', e));
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  schedulers.set(ctx.store, timer);
  tick();
}

export function stopDraftScheduler(store: MessageStore): void {
  clearInterval(schedulers.get(store));
  schedulers.delete(store);
}
