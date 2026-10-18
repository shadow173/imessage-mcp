// What search and fetch share: signed citation links (/view), which expire and never show more than fetch did, and
// the attachments whose text fetch can return.

import type { AttachmentKind } from '../../domain/attachments.js';
import { viewLink } from '../../links.js';
import type { MessageStore } from '../../store/ports.js';
import type { Attachment, Chat, Message } from '../../store/types.js';
import type { Ctx } from '../context.js';

const viewUrl = (ctx: Ctx, kind: 'chat' | 'msg', id: string) =>
  viewLink(ctx.baseUrl, ctx.cfg.linkSecret, kind, id, ctx.store.now());
export const chatUrl = (ctx: Ctx, chatId: string) => viewUrl(ctx, 'chat', chatId);
export const msgUrl = (ctx: Ctx, id: string) => viewUrl(ctx, 'msg', id);

const TEXT_KINDS = new Set<AttachmentKind>(['pdf', 'document', 'image', 'voice_memo']);
export const dmVia = (c: Chat) =>
  c.service !== 'iMessage' ? c.service : c.chatId.includes('@') ? 'email' : 'iMessage';

export function textAttachments(store: MessageStore, msgs: Message[], max: number): Attachment[] {
  const out: Attachment[] = [];
  for (const m of msgs) {
    if (m.unsent) continue;
    for (const id of m.attachmentIds) {
      const a = store.attachment(id);
      if (a && TEXT_KINDS.has(a.kind) && out.length < max) out.push(a);
    }
  }
  return out;
}
