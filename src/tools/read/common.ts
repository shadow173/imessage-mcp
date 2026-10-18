// What the read tools share: update types, the filter a get_updates cursor is pinned to, from-filter keys, and
// readKit, the helpers bound to one request.

import * as z from 'zod/v4';
import { kindLabel } from '../../domain/attachments.js';
import { chatGuidIdentifier } from '../../domain/chatGuid.js';
import { ToolError } from '../../lib/errors.js';
import { partsOf } from '../../lib/format.js';
import { siblingDms } from '../../lib/resolve.js';
import { fmtDay, fmtIso } from '../../lib/time.js';
import {
  type Attachment,
  type Chat,
  type DismissedReminder,
  type FromFilter,
  ME,
  type Message,
  type MessageFilter,
  type Reminder,
} from '../../store/types.js';
import type { Ctx } from '../context.js';

export const UPDATE_TYPES = ['new', 'edited', 'unsent', 'reaction', 'delivered', 'read'] as const;
export type UpdateType = (typeof UPDATE_TYPES)[number];

export const zId = z.string().max(1000);

/** The filter a get_updates cursor is pinned to. */
export const UpFilter = z.object({
  /** chat_ids. */
  c: z.array(zId).max(1000).optional(),
  /** The person those chats came from. */
  p: zId.optional(),
  /** Event types. */
  ty: z.array(z.enum(UPDATE_TYPES)).optional(),
  /** from as fromKey. */
  fr: zId.optional(),
});
export type UpFilter = z.infer<typeof UpFilter>;

export const fromKey = (f?: FromFilter) => (!f ? undefined : f.kind === 'person' ? f.personId : f.kind);
export const fromOfKey = (k?: string): FromFilter | undefined =>
  !k ? undefined : k === 'me' ? { kind: 'me' } : k === 'others' ? { kind: 'others' } : { kind: 'person', personId: k };
export const unreadIncoming = (m: Message) => m.senderId !== ME && !m.isRead && !m.system && !m.unsent;
export const dismissOf = (r: Reminder) => r.dismissWhen ?? (r.dismissOnReply ? 'they_reply' : 'never');
export const fileTag = (a: Attachment) => `${kindLabel(a.kind)} ${a.name}`;

/** Helpers the read tools share, bound to one request's context. */
export function readKit(ctx: Ctx) {
  const { store } = ctx;
  const tz = store.timeZone;
  const iso = (ms?: number) => (ms === undefined ? null : fmtIso(ms, tz));
  const chatTitleOf = (chatId: string) => {
    const c = store.chat(chatId);
    return c ? store.chatTitle(c) : chatId;
  };
  const fromLabel = (f: FromFilter) =>
    f.kind === 'person' ? store.personName(f.personId) : f.kind === 'me' ? 'you' : 'others';
  const reminderJson = (r: Reminder) => ({
    reminder_id: r.reminderId,
    chat_id: r.chatId,
    title: chatTitleOf(r.chatId),
    remind_at: fmtIso(r.remindAt, tz),
    note: r.note,
    dismiss_when: dismissOf(r),
  });
  /** Who cleared an auto-dismissed reminder: "you" or the sender's name, from the message that did it. */
  const dismissedByName = (d: DismissedReminder) => {
    const m = d.dismissedBy ? store.message(d.dismissedBy) : undefined;
    return m
      ? m.senderId === ME
        ? 'you'
        : store.personName(m.senderId)
      : d.dismissWhen === 'i_reply'
        ? 'you'
        : 'them';
  };
  const dismissedJson = (d: DismissedReminder) => ({
    reminder_id: d.reminderId,
    chat_id: d.chatId,
    title: chatTitleOf(d.chatId),
    remind_at: fmtIso(d.remindAt, tz),
    note: d.note ?? null,
    dismiss_when: d.dismissWhen,
    auto_dismissed_at: fmtIso(d.dismissedAt, tz),
    dismissed_by: d.dismissedBy ?? null,
    dismissed_by_name: dismissedByName(d),
  });

  /**
   * The person's other 1:1 threads; inRange counts each one's messages under filter when a window or from is active.
   */
  const otherDms = (chat: Chat, filter?: MessageFilter) =>
    siblingDms(store, chat).map((c) => ({
      c,
      s: store.summarizeChat(c.chatId),
      inRange: filter ? store.pageChat(c.chatId, filter, { limit: 1, anchor: 'end' }).total : undefined,
    }));
  type Sibling = ReturnType<typeof otherDms>[number];
  const siblingJson = (x: Sibling) => ({
    chat_id: x.c.chatId,
    service: x.c.service,
    via: chatGuidIdentifier(x.c.chatId),
    unread_count: x.s.unreadCount,
    needs_reply: x.s.needsReply,
    last_activity: iso(x.s.lastMessage?.sentAt),
    ...(x.inRange !== undefined ? { in_range: x.inRange } : {}),
  });
  const siblingLine = (chat: Chat, sibs: Sibling[], countWord: string) =>
    `Also 1:1 with ${store.personName(chat.participantIds[0])}: ${sibs
      .map((x) => {
        const bits: string[] = [x.c.service];
        if (x.s.lastMessage) bits.push(`last ${fmtDay(x.s.lastMessage.sentAt, tz, store.now())}`);
        if (x.s.unreadCount) bits.push(`${x.s.unreadCount} unread`);
        if (x.s.needsReply) bits.push('needs reply');
        if (x.inRange !== undefined) bits.push(`${x.inRange} ${countWord}`);
        return `${x.c.chatId} (${bits.join(' · ')})`;
      })
      .join(' · ')}`;

  /**
   * "0 text · 1 photo IMG_2.JPG": the store's bubble order (the tapback part index), or Messages' usual files-then-text
   * when it isn't known.
   */
  const bubbles = (m: Message) => {
    const parts = partsOf(store, m);
    const tag = (id?: string) => {
      const a = id ? store.attachment(id) : undefined;
      return a ? fileTag(a) : 'file';
    };
    if (parts) return parts.map((p, i) => `${i} ${p.kind === 'text' ? 'text' : tag(p.attachmentId)}`).join(' · ');
    const files = m.attachmentIds
      .map((id) => store.attachment(id))
      .filter((x): x is Attachment => !!x)
      .map(fileTag);
    const n = m.partCount ?? files.length;
    return `${n} (${[...files, `${n - files.length} text`].join(', ')}; order unknown)`;
  };

  /** Is the new filter inside the one the cursor was pinned to (chats, types and from each the same or narrower)? */
  const narrowerOrSame = (
    old: UpFilter,
    now: { chatIds?: string[]; personId?: string; types?: UpdateType[]; fr?: string },
  ) => {
    const dmOf = (id: string, pid: string) => {
      const c = store.chat(id);
      return !!c && c.type === 'dm' && c.participantIds[0] === pid;
    };
    const chatsOk = !old.c
      ? true
      : !now.chatIds
        ? false
        : old.p && now.personId === old.p
          ? true
          : now.chatIds.every((id) => old.c!.includes(id) || (!!old.p && dmOf(id, old.p)));
    const typesOk = !old.ty || (!!now.types && now.types.every((t) => old.ty!.includes(t)));
    return chatsOk && typesOk && (!old.fr || old.fr === now.fr);
  };
  const filterJson = (f: UpFilter) => ({ chat_ids: f.c ?? null, types: f.ty ?? null, from: f.fr ?? null });
  const refilterNote = (f: UpFilter) =>
    `This cursor was made for ${[f.c ? `chat_ids ${f.c.join(', ')}` : '', f.ty ? `types ${f.ty.join(',')}` : '', f.fr ? `from ${fromLabel(fromOfKey(f.fr)!)}` : ''].filter(Boolean).join(' · ') || 'no filter'}; the new filter applies from the cursor's position, so nothing pending is lost. Changes the old filter skipped before that position are not repeated; check read_conversation if you need them.`;

  const expired = (t?: number) =>
    typeof t === 'number'
      ? new ToolError(
          'cursor_expired',
          `Changes since ${fmtIso(t, tz)} are no longer available. The Mac's bridge restarted or the cursor is too old.`,
          `Call catch_up with since="${fmtIso(t, tz)}" to see what you missed, then call get_updates with cursor="now".`,
        )
      : new ToolError(
          'cursor_expired',
          "Changes since that cursor are no longer available. The Mac's bridge restarted or the cursor is too old.",
          'Call catch_up to see what you missed, then call get_updates with cursor="now".',
        );
  return {
    store,
    tz,
    iso,
    chatTitleOf,
    fromLabel,
    reminderJson,
    dismissedByName,
    dismissedJson,
    otherDms,
    siblingJson,
    siblingLine,
    bubbles,
    narrowerOrSame,
    filterJson,
    refilterNote,
    expired,
  };
}
