// One line per chat: its last message, unread count and whether it needs a reply, computed for every chat at once
// and cached briefly.

import { isUnknownSender } from '../domain/naming.js';
import { isShortCodePerson, NEEDS_REPLY_WINDOW_MS, needsReply } from '../domain/needsReply.js';
import { chunks, getOrInit } from '../lib/collections.js';
import { ToolError } from '../lib/errors.js';
import { type ChatSummary, ME, type ReactionKind } from '../store/types.js';
import type { LiveContext } from './context.js';
import type { Hydrator } from './hydrate.js';
import { fromDb, MSG_COLS, type MsgRow, REAL, type Row } from './sql.js';
import { decodeTapback, TAPBACK_SQL, tapbackCandidates, tapbackTarget } from './tapbacks.js';

export class Summaries {
  private cache: { at: number; byGuid: Map<string, ChatSummary> } | null = null;

  constructor(
    private ctx: LiveContext,
    private hydrator: Hydrator,
  ) {}

  /** Drops the cache: after new messages, reads, label changes or a directory reload. */
  invalidate() {
    this.cache = null;
  }

  chatSummaries(): ChatSummary[] {
    return [...this.byChat().values()];
  }

  summarizeChat(chatId: string): ChatSummary {
    const c = this.ctx.dir.chat(chatId);
    if (!c) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    return (
      this.byChat().get(c.chatId) ?? {
        chat: c,
        title: this.ctx.dir.chatTitle(c),
        unreadCount: 0,
        needsReply: false,
        messageCount: 0,
        unknownSender: false,
      }
    );
  }

  /** Every visible chat's summary by chat_id, reused for two minutes unless invalidated. */
  private byChat(): Map<string, ChatSummary> {
    if (this.cache && Date.now() - this.cache.at < 120_000) return this.cache.byGuid;
    // Latest row per chat from the join table alone (fast), then fix up the few chats whose latest row is a tapback or
    // event.
    const last = this.ctx
      .big('select chat_id c, message_id mid, max(message_date) d, count(*) n from chat_message_join group by chat_id')
      .all() as { c: bigint; mid: bigint; d: bigint | null; n: bigint }[];
    const visible = last.filter((r) => this.ctx.dir.chatsByRowid.has(Number(r.c)));
    const rowsByChat = new Map<number, MsgRow>();
    for (const chunk of chunks(
      visible.map((r) => Number(r.mid)),
      800,
    )) {
      for (const r of this.ctx.db
        .prepare(
          `select ${MSG_COLS}, cmj.chat_id chat_rowid, (${REAL()}) is_real from message m join chat_message_join cmj on cmj.message_id = m.ROWID where m.ROWID in (${chunk.join(',')})`,
        )
        .all() as (MsgRow & { is_real: number })[]) {
        if (r.is_real) rowsByChat.set(Number(r.chat_rowid), r);
      }
    }
    const fallback = this.ctx.db.prepare(
      `select ${MSG_COLS}, cmj.chat_id chat_rowid from message m join chat_message_join cmj on cmj.message_id = m.ROWID where cmj.chat_id = ? and ${REAL()} order by cmj.message_date desc limit 1`,
    );
    for (const v of visible) {
      const c = Number(v.c);
      if (!rowsByChat.has(c)) {
        const r = fallback.get(c) as MsgRow | undefined;
        if (r) rowsByChat.set(c, r);
      }
    }
    const unread = new Map(
      (
        this.ctx.db
          .prepare(
            `select cmj.chat_id c, count(*) n from message m join chat_message_join cmj on cmj.message_id = m.ROWID where m.is_read = 0 and m.is_from_me = 0 and ${REAL()} group by cmj.chat_id`,
          )
          .all() as Row[]
      ).map((r) => [Number(r.c), Number(r.n)]),
    );
    const msgs = new Map(this.hydrator.hydrate([...rowsByChat.values()], { light: true }).map((m) => [m.chatId, m]));
    const counts = new Map(visible.map((v) => [Number(v.c), Number(v.n)]));
    const out = new Map<string, ChatSummary>();
    const now = Date.now();
    // An owner tapback on the last message (not taken back) acknowledges it: one batched lookup for the chats that
    // could need a reply.
    const acked = this.ownerTapbacked(
      [...rowsByChat.values()]
        .filter((r) => !r.is_from_me && now - (fromDb(r.date_ms) ?? 0) < NEEDS_REPLY_WINDOW_MS)
        .map((r) => String(r.guid)),
    );
    for (const [rowid, chat] of this.ctx.dir.chatsByRowid) {
      const lm = msgs.get(chat.chatId);
      if (!lm) continue;
      const other = chat.type === 'dm' ? this.ctx.dir.peopleById.get(chat.participantIds[0] ?? '') : undefined;
      out.set(chat.chatId, {
        chat,
        title: this.ctx.dir.chatTitle(chat),
        lastMessage: lm,
        messageCount: counts.get(rowid) ?? 0,
        unreadCount: unread.get(rowid) ?? 0,
        needsReply: needsReply({
          fromOwner: lm.senderId === ME,
          ageMs: now - lm.sentAt,
          shortCode: isShortCodePerson(other),
          ownerTapback: acked.has(String(rowsByChat.get(rowid)?.guid)),
        }),
        unknownSender: isUnknownSender(chat, other),
      });
    }
    this.cache = { at: Date.now(), byGuid: out };
    return out;
  }

  /** Message guids carrying a standing owner tapback on any part. */
  private ownerTapbacked(guids: string[]): Set<string> {
    const live = new Map<string, Map<number, ReactionKind>>();
    for (const chunk of chunks(
      guids.flatMap((g) => tapbackCandidates(g)),
      900,
    )) {
      for (const r of this.ctx.db
        .prepare(
          `select associated_message_guid ag, associated_message_type t from message where is_from_me = 1 and associated_message_guid in (${chunk.map(() => '?').join(',')}) and ${TAPBACK_SQL()} order by date`,
        )
        .all(...chunk) as Row[]) {
        const tb = decodeTapback(Number(r.t));
        if (!tb) continue;
        const { part, guid } = tapbackTarget(String(r.ag));
        const per = getOrInit(live, guid, () => new Map<number, ReactionKind>());
        if (tb.removed) {
          if (per.get(part) === tb.kind) per.delete(part);
        } else per.set(part, tb.kind);
      }
    }
    return new Set([...live].filter(([, per]) => per.size).map(([g]) => g));
  }
}
