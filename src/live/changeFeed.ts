// The update feed behind get_updates and imessage watch: new rows, tapbacks, edits, unsends and receipts in chat.db,
// found by polling and kept as numbered events.

import { type EventExtra, EventLog } from '../store/eventLog.js';
import { ME, type Message, type UpdateEvent } from '../store/types.js';
import type { LiveContext } from './context.js';
import type { ChatRec } from './directory.js';
import type { SearchIndex } from './searchIndex.js';
import { MIN_CHAT_JOIN, type Row } from './sql.js';
import { decodeTapback, isTapbackType, tapbackTarget } from './tapbacks.js';

export interface FeedDeps {
  message(id: string): Message | undefined;
  invalidateSummaries(): void;
  /** For rows in a chat the directory doesn't know yet. */
  reloadDirectory(): void;
  index: Pick<SearchIndex, 'reindex'>;
}

export class ChangeFeed {
  private log = new EventLog(() => Date.now());
  /** High-water marks: the newest row id and the latest edit, read and delivered dates already reported. */
  private hw = { rowid: 0, edited: 0n, read: 0n, delivered: 0n, readIn: 0n };
  private polling = false;

  constructor(
    private ctx: LiveContext,
    private deps: FeedDeps,
  ) {}

  /** Starts from what chat.db holds now, so only later rows and changes become events. */
  markStart() {
    const m = this.ctx
      .big(
        `select max(ROWID) r, max(date_edited) e, max(case when is_from_me = 1 then date_read end) rd, max(date_delivered) dl from message`,
      )
      .get() as { r: bigint | null; e: bigint | null; rd: bigint | null; dl: bigint | null };
    this.hw = {
      rowid: Number(m.r ?? 0),
      edited: BigInt(m.e ?? 0),
      read: BigInt(m.rd ?? 0),
      delivered: BigInt(m.dl ?? 0),
      readIn: -1n,
    };
  }

  /** The newest row id seen, for health. */
  get lastRowid(): number {
    return this.hw.rowid;
  }

  private emit(type: UpdateEvent['type'], messageId: string, chatId: string, extra: EventExtra = {}) {
    this.log.emit(type, messageId, chatId, extra);
  }

  /** New rows by ROWID, and in-place changes (edits, unsends, receipts) by date high-water marks. */
  poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const fresh = this.ctx
        .big(
          `select m.ROWID r, m.guid, m.associated_message_guid ag, m.associated_message_type t, m.associated_message_emoji e,
          m.is_from_me me, m.handle_id h, m.item_type, cmj.chat_id c
        from message m ${MIN_CHAT_JOIN} where m.ROWID > ? order by m.ROWID limit 1000`,
        )
        .all(this.hw.rowid) as {
        r: bigint;
        guid: string;
        ag: string | null;
        t: bigint | null;
        e: string | null;
        me: bigint;
        h: bigint;
        item_type: bigint;
        c: bigint;
      }[];
      const changed = new Set<number>();
      for (const r of fresh) {
        this.hw.rowid = Math.max(this.hw.rowid, Number(r.r));
        const chat = this.ctx.dir.chatsByRowid.get(Number(r.c));
        if (!chat) continue;
        const t = Number(r.t ?? 0);
        const actor = this.actorOf(r, chat);
        if (isTapbackType(t)) {
          const target = this.ctx
            .stmt('select ROWID r from message where guid = ?')
            .get(tapbackTarget(String(r.ag)).guid) as Row | undefined;
          // A sticker on a message is reported as a reaction event without a kind.
          const tb = decodeTapback(t);
          const reaction = tb
            ? {
                reaction: {
                  kind: tb.kind,
                  ...(tb.kind === 'emoji' && r.e ? { emoji: String(r.e) } : {}),
                  removed: tb.removed,
                },
              }
            : {};
          if (target) this.emit('reaction', `m${target.r}`, chat.chatId, { ...actor, ...reaction });
        } else this.emit('new', `m${r.r}`, chat.chatId, actor);
        changed.add(Number(r.r));
      }
      const edits = this.ctx
        .big(
          `select m.ROWID r, m.date_edited e, m.text, m.attributedBody body, m.is_from_me me, m.handle_id h, cmj.chat_id c
        from message m ${MIN_CHAT_JOIN} where m.date_edited > ? order by m.date_edited limit 500`,
        )
        .all(this.hw.edited) as {
        r: bigint;
        e: bigint;
        text: string | null;
        body: Uint8Array | null;
        me: bigint;
        h: bigint;
        c: bigint;
      }[];
      for (const r of edits) {
        this.hw.edited = BigInt(r.e) > this.hw.edited ? BigInt(r.e) : this.hw.edited;
        const chat = this.ctx.dir.chatsByRowid.get(Number(r.c));
        if (chat) {
          const unsent = r.text == null && r.body == null;
          const prev = unsent ? undefined : this.deps.message(`m${r.r}`)?.editHistory?.at(-1)?.text;
          this.emit(unsent ? 'unsent' : 'edited', `m${r.r}`, chat.chatId, {
            ...this.actorOf(r, chat),
            ...(prev !== undefined ? { previousText: prev } : {}),
          });
        }
        changed.add(Number(r.r));
      }
      for (const [col, type] of [
        ['date_read', 'read'],
        ['date_delivered', 'delivered'],
      ] as const) {
        const key = col === 'date_read' ? 'read' : 'delivered';
        const rs = this.ctx
          .big(
            `select m.ROWID r, m.${col} v, cmj.chat_id c from message m ${MIN_CHAT_JOIN} where m.is_from_me = 1 and m.${col} > ? order by m.${col} limit 500`,
          )
          .all(this.hw[key]) as { r: bigint; v: bigint; c: bigint }[];
        for (const r of rs) {
          if (BigInt(r.v) > this.hw[key]) this.hw[key] = BigInt(r.v);
          const chat = this.ctx.dir.chatsByRowid.get(Number(r.c));
          if (chat && !changed.has(Number(r.r)))
            this.emit(
              type,
              `m${r.r}`,
              chat.chatId,
              chat.type === 'dm' && chat.participantIds[0] ? { actorId: chat.participantIds[0] } : {},
            );
        }
      }
      // Messages read on the phone change unread counts without adding rows; the unread index makes this cheap.
      const unreadNow = BigInt(
        (
          this.ctx
            .stmt('select count(*) n from message where is_read = 0 and is_from_me = 0 and item_type = 0')
            .get() as { n: number }
        ).n,
      );
      if (unreadNow !== this.hw.readIn) {
        this.hw.readIn = unreadNow;
        this.deps.invalidateSummaries();
      }
      if (fresh.length || edits.length) {
        this.deps.invalidateSummaries();
        if (
          fresh.some(
            (r) => !this.ctx.dir.chatsByRowid.has(Number(r.c)) && !this.ctx.dir.hiddenChatRowids.has(Number(r.c)),
          )
        )
          this.deps.reloadDirectory();
        this.deps.index.reindex([...changed]);
      }
    } catch (e) {
      console.error('poll failed', (e as Error).message);
    } finally {
      this.polling = false;
    }
  }

  /** Who caused a row: the owner, the person behind its handle, or the other side of a 1:1. */
  private actorOf(r: { me: bigint; h: bigint }, chat: ChatRec): { actorId?: string } {
    if (Number(r.me)) return { actorId: ME };
    const pid =
      this.ctx.dir.personIdByKey.get(this.ctx.dir.handleKeyByRowid.get(Number(r.h)) ?? '') ??
      (chat.type === 'dm' ? chat.participantIds[0] : undefined);
    return pid ? { actorId: pid } : {};
  }

  updatesSince(seq: number): UpdateEvent[] {
    return this.log.updatesSince(seq);
  }

  latestSeq(): number {
    return this.log.latestSeq();
  }

  oldestSeq(): number {
    return this.log.oldestSeq();
  }

  waitForUpdate(afterSeq: number, timeoutMs: number): Promise<void> {
    return this.log.waitForUpdate(afterSeq, timeoutMs);
  }
}
