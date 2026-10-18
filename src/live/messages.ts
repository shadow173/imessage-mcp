// Reading messages: one by id, a page of one chat, filtered lists across chats, neighbors and inline-reply threads.

import { ToolError } from '../lib/errors.js';
import type { ChatPage, ListPage, Message, MessageFilter, MsgKey } from '../store/types.js';
import { toAppleNs } from './appleTime.js';
import type { LiveContext } from './context.js';
import type { Hydrator } from './hydrate.js';
import type { SearchIndex } from './searchIndex.js';
import { AGG_JOIN, MIN_CHAT_JOIN, MSG_COLS, type MsgRow, messageWhere, REAL, type Row, sqlCount } from './sql.js';

export class MessageReader {
  constructor(
    private ctx: LiveContext,
    private hydrator: Hydrator,
    private index: SearchIndex,
  ) {}

  /** MSG_COLS rows matching whereSql, each message once (with its lowest chat). */
  private rows(whereSql: string, params: (string | number | bigint)[], tail: string, includeSystem = false): MsgRow[] {
    return this.ctx.db
      .prepare(
        `select ${MSG_COLS}, cmj.chat_id chat_rowid from message m ${MIN_CHAT_JOIN} where ${REAL(includeSystem)} and ${whereSql} ${tail}`,
      )
      .all(...params) as MsgRow[];
  }

  message(id: string): Message | undefined {
    const rowid = Number(String(id).replace(/^#?m/, ''));
    if (!rowid) {
      const r = this.ctx.stmt('select ROWID r from message where guid = ?').get(id) as Row | undefined;
      if (!r) return undefined;
      return this.message(`m${r.r}`);
    }
    const rows = this.ctx.db
      .prepare(`select ${MSG_COLS}, cmj.chat_id chat_rowid from message m ${MIN_CHAT_JOIN} where m.ROWID = ?`)
      .all(rowid) as MsgRow[];
    if (!rows.length || this.ctx.dir.hiddenChatRowids.has(Number(rows[0].chat_rowid))) return undefined;
    return this.hydrator.hydrate(rows)[0];
  }

  pageChat(
    chatId: string,
    filter: MessageFilter,
    o: { limit: number; before?: MsgKey; after?: MsgKey; anchor: 'start' | 'end' },
  ): ChatPage {
    const chat = this.ctx.dir.chatRec(chatId);
    if (!chat) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    const w = messageWhere(this.ctx.dir, {
      ...filter,
      chatIds: undefined,
      withPersonId: undefined,
      chatType: undefined,
      service: undefined,
    });
    const base = `cmj.chat_id = ${chat.rowid} and ${w.sql.join(' and ')}`;
    const sel = (cond: string, params: (string | number | bigint)[], order: 'asc' | 'desc', limit: number) =>
      this.ctx.db
        .prepare(
          `select ${MSG_COLS}, cmj.chat_id chat_rowid
          from message m join chat_message_join cmj on cmj.message_id = m.ROWID
          where ${REAL(filter.includeSystem)} and ${base} ${cond}
          order by cmj.message_date ${order}, m.ROWID ${order} limit ?`,
        )
        .all(...w.params, ...params, sqlCount(limit, 'limit')) as MsgRow[];
    const keyLt = (k: MsgKey) => ({
      sql: 'and (cmj.message_date < ? or (cmj.message_date < ? and m.ROWID < ?))',
      params: [toAppleNs(k.t), toAppleNs(k.t + 1), Number(k.id.replace(/\D/g, ''))],
    });
    const keyGt = (k: MsgKey) => ({
      sql: 'and (cmj.message_date >= ? or (cmj.message_date >= ? and m.ROWID > ?))',
      params: [toAppleNs(k.t + 1), toAppleNs(k.t), Number(k.id.replace(/\D/g, ''))],
    });
    let rows: MsgRow[];
    if (o.before) {
      const k = keyLt(o.before);
      rows = sel(k.sql, k.params, 'desc', o.limit).reverse();
    } else if (o.after) {
      const k = keyGt(o.after);
      rows = sel(k.sql, k.params, 'asc', o.limit);
    } else if (o.anchor === 'start') rows = sel('', [], 'asc', o.limit);
    else rows = sel('', [], 'desc', o.limit).reverse();
    const items = this.hydrator.hydrate(rows);
    const exists = (cond: { sql: string; params: (string | number | bigint)[] }) =>
      !!this.ctx.db
        .prepare(
          `select 1 from message m join chat_message_join cmj on cmj.message_id = m.ROWID where ${REAL(filter.includeSystem)} and ${base} ${cond.sql} limit 1`,
        )
        .get(...w.params, ...cond.params);
    const first = items[0],
      lastM = items[items.length - 1];
    const total = Number(
      (
        this.ctx.db
          .prepare(
            `select count(*) n from message m join chat_message_join cmj on cmj.message_id = m.ROWID where ${REAL(filter.includeSystem)} and ${base}`,
          )
          .get(...w.params) as Row
      ).n,
    );
    return {
      items,
      total,
      hasOlder: first ? exists(keyLt({ t: first.sentAt, id: first.messageId })) : false,
      hasNewer: lastM ? exists(keyGt({ t: lastM.sentAt, id: lastM.messageId })) : false,
    };
  }

  listMessages(filter: MessageFilter, o: { order: 'asc' | 'desc'; limit: number; offset: number }): ListPage {
    if (filter.text)
      return this.index.search(
        { ...filter, text: filter.text },
        { sort: o.order === 'asc' ? 'oldest' : 'newest', limit: o.limit, offset: o.offset },
      );
    const w = messageWhere(this.ctx.dir, filter);
    const order = o.order === 'asc' ? 'asc' : 'desc';
    const rows = this.rows(
      w.sql.join(' and '),
      [...w.params, sqlCount(o.limit, 'limit'), sqlCount(o.offset, 'offset')],
      `order by m.date ${order}, m.ROWID ${order} limit ? offset ?`,
      filter.includeSystem,
    );
    const total = Number(
      (
        this.ctx.db
          .prepare(
            `select count(*) n from message m ${AGG_JOIN} where ${REAL(filter.includeSystem)} and ${w.sql.join(' and ')}`,
          )
          .get(...w.params) as Row
      ).n,
    );
    return { items: this.hydrator.hydrate(rows), total };
  }

  messagesAround(messageId: string, before: number, after: number, includeSystem = true): Message[] {
    const m = this.message(messageId);
    if (!m) return [];
    const k = { t: m.sentAt, id: m.messageId };
    const older = before
      ? this.pageChat(m.chatId, { includeSystem }, { limit: before, before: k, anchor: 'end' }).items
      : [];
    const newer = after
      ? this.pageChat(m.chatId, { includeSystem }, { limit: after, after: k, anchor: 'start' }).items
      : [];
    return [...older, m, ...newer];
  }

  threadReplies(originatorId: string): Message[] {
    const rowid = Number(originatorId.replace(/\D/g, ''));
    const g = this.ctx.stmt('select guid from message where ROWID = ?').get(rowid) as Row | undefined;
    if (!g) return [];
    const w = messageWhere(this.ctx.dir, {});
    return this.hydrator.hydrate(
      this.rows(
        `m.thread_originator_guid = ? and ${w.sql.join(' and ')}`,
        [String(g.guid), ...w.params],
        'order by m.date asc limit 1000',
      ),
    );
  }
}
