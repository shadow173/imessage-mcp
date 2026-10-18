// What the people tools share: peopleKit, the helpers bound to one request.

import { fmtIso, localParts } from '../../lib/time.js';
import { type ChatSummary, ME } from '../../store/types.js';
import type { Ctx } from '../context.js';

export const pad = (n: number) => String(n).padStart(2, '0');

/** Helpers the people tools share, bound to one request's context. */
export function peopleKit(ctx: Ctx) {
  const { store, cfg } = ctx;
  const tz = store.timeZone;
  const monthKey = (ms: number) => {
    const p = localParts(ms, tz);
    return `${p.y}-${pad(p.mo)}`;
  };
  const lastFrom = (s: ChatSummary) =>
    s.lastMessage ? (s.lastMessage.senderId === ME ? 'me' : store.personName(s.lastMessage.senderId)) : null;
  const chatState = (s: ChatSummary) => ({
    last_activity: s.lastMessage ? fmtIso(s.lastMessage.sentAt, tz) : null,
    last_from: lastFrom(s),
    needs_reply: s.needsReply,
    unread_count: s.unreadCount,
  });
  return { store, cfg, tz, monthKey, chatState };
}
