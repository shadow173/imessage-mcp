// Attachment rows as Attachments: lookups by id, listing with filters, and the on-disk path behind each one.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AttachmentKind } from '../domain/attachments.js';
import { queryTerms } from '../store/match.js';
import { type Attachment, type AttachmentFilter, type ListPage, ME } from '../store/types.js';
import type { LiveContext } from './context.js';
import {
  AGG_JOIN,
  ATTACHMENT_COLS,
  type AttachmentRow,
  escLike,
  fromDb,
  KIND_SQL,
  MESSAGE_SCOPE,
  MIN_CHAT_JOIN,
  type Row,
  SHOWN_ATTACHMENT,
  scopeWhere,
  sqlCount,
} from './sql.js';

/** An attachment's kind from its MIME type and UTI, the sticker flag and whether it was sent as a voice memo. */
export function attachmentKind(
  mime: string | null,
  uti: string | null,
  sticker: number,
  audioMsg: number,
): AttachmentKind {
  if (sticker) return 'sticker';
  const m = (mime ?? '').toLowerCase(),
    u = (uti ?? '').toLowerCase();
  if (audioMsg || u.includes('caf')) return 'voice_memo';
  if (m.startsWith('image/') || u.includes('image') || u.includes('heic') || u.includes('jpeg') || u.includes('png'))
    return 'image';
  if (m.startsWith('video/') || u.includes('movie') || u.includes('video')) return 'video';
  if (m.startsWith('audio/') || u.includes('audio')) return 'audio';
  if (m === 'application/pdf' || u.includes('pdf')) return 'pdf';
  return 'document';
}

export class AttachmentCatalog {
  private cache = new Map<string, Attachment>();

  constructor(private ctx: LiveContext) {}

  /** Forgets cached attachments, so a chat that became hidden (or a renamed sender) applies to the next lookup. */
  clear() {
    this.cache.clear();
  }

  /** An ATTACHMENT_COLS row as an Attachment, cached by id. */
  fromRow(a: AttachmentRow, chatId: string): Attachment {
    const id = `a${a.r}`;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const { dir } = this.ctx;
    const sender = a.is_from_me
      ? ME
      : (dir.personIdByKey.get(dir.handleKeyByRowid.get(Number(a.handle_id)) ?? '') ?? 'unknown');
    const file = a.filename ? String(a.filename).replace(/^~/, process.env.HOME ?? homedir()) : '';
    const att: Attachment & { path?: string } = {
      attachmentId: id,
      messageId: `m${a.mid}`,
      chatId,
      senderId: sender,
      sentAt: fromDb(a.date_ms) ?? 0,
      name: String(a.transfer_name ?? file.split('/').pop() ?? 'attachment'),
      mime: String(a.mime_type ?? 'application/octet-stream'),
      bytes: Number(a.total_bytes ?? 0),
      kind: attachmentKind(a.mime_type, a.uti, Number(a.is_sticker), Number(a.is_audio_message)),
      path: file,
      onDevice: !!file && existsSync(file),
    };
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(id, att);
    return att;
  }

  get(id: string): Attachment | undefined {
    if (this.cache.has(id)) return this.cache.get(id);
    const rowid = Number(id.replace(/^a/, ''));
    if (!rowid) return undefined;
    const a = this.ctx.db
      .prepare(`select ${ATTACHMENT_COLS}, cmj.chat_id chat_rowid
      from attachment a join message_attachment_join maj on maj.attachment_id = a.ROWID join message m on m.ROWID = maj.message_id ${MIN_CHAT_JOIN} where a.ROWID = ?`)
      .get(rowid) as AttachmentRow | undefined;
    if (!a || this.ctx.dir.hiddenChatRowids.has(Number(a.chat_rowid))) return undefined;
    return this.fromRow(a, this.ctx.dir.chatsByRowid.get(Number(a.chat_rowid))?.chatId ?? 'unknown');
  }

  /** Absolute path of an attachment on disk, for previews and downloads on the bridge. */
  path(id: string): string | undefined {
    return (this.get(id) as (Attachment & { path?: string }) | undefined)?.path;
  }

  list(f: AttachmentFilter, o: { limit: number; offset: number }): ListPage<Attachment> {
    const { dir } = this.ctx;
    const scope = { chatIds: f.chatId ? [f.chatId] : undefined, from: f.from, after: f.after, before: f.before };
    const { sql: conds, params } = scopeWhere(dir, scope, MESSAGE_SCOPE, { sql: [SHOWN_ATTACHMENT], params: [] });
    if (f.kinds?.length) conds.push(`(${f.kinds.map((k) => KIND_SQL[k]).join(' or ')})`);
    for (const t of f.nameQuery ? queryTerms(f.nameQuery) : []) {
      conds.push("a.transfer_name like ? escape '\\'");
      params.push(`%${escLike(t)}%`);
    }
    const from = `from attachment a join message_attachment_join maj on maj.attachment_id = a.ROWID join message m on m.ROWID = maj.message_id ${AGG_JOIN} where ${conds.join(' and ')}`;
    const rows = this.ctx.db
      .prepare(
        `select ${ATTACHMENT_COLS}, min(cmj.chat_id) chat_rowid ${from} group by a.ROWID order by m.date desc limit ? offset ?`,
      )
      .all(...params, sqlCount(o.limit, 'limit'), sqlCount(o.offset, 'offset')) as AttachmentRow[];
    const total = Number((this.ctx.db.prepare(`select count(distinct a.ROWID) n ${from}`).get(...params) as Row).n);
    return {
      items: rows.map((a) => this.fromRow(a, dir.chatsByRowid.get(Number(a.chat_rowid))?.chatId ?? 'unknown')),
      total,
    };
  }
}
