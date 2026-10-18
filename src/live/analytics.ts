// Counts over many messages: a person's history with the owner, a chat's activity, grouped stats and totals.

import { ToolError } from '../lib/errors.js';
import { localParts } from '../lib/time.js';
import { DAY_MS } from '../lib/units.js';
import { groupStats } from '../store/stats.js';
import {
  type ChatActivity,
  ME,
  type MessageFilter,
  type PersonActivity,
  type StatGroup,
  type StatMetric,
  type StatRow,
} from '../store/types.js';
import { APPLE_EPOCH_MS, fromAppleNs, toAppleNs } from './appleTime.js';
import type { LiveContext } from './context.js';
import type { Hydrator } from './hydrate.js';
import type { MessageReader } from './messages.js';
import {
  AGG_JOIN,
  MSG_COLS,
  type MsgRow,
  messageWhere,
  notHidden,
  REAL,
  type Row,
  SQL_MS,
  URL_BALLOON,
} from './sql.js';
import type { Summaries } from './summaries.js';

export class Analytics {
  constructor(
    private ctx: LiveContext,
    private hydrator: Hydrator,
    private reader: MessageReader,
    private summaries: Summaries,
  ) {}

  personActivity(personId: string): PersonActivity {
    const hs = this.ctx.dir.personHandleRowids(personId);
    const dmChatIds: string[] = [],
      groupChatIds: string[] = [],
      dmRowids: number[] = [];
    for (const c of this.ctx.dir.chatsByRowid.values()) {
      if (!c.participantIds.includes(personId)) continue;
      if (c.type === 'dm') {
        dmChatIds.push(c.chatId);
        dmRowids.push(c.rowid);
      } else groupChatIds.push(c.chatId);
    }
    const cond = [
      dmRowids.length ? `cmj.chat_id in (${dmRowids.join(',')})` : '',
      hs.length ? `(m.is_from_me = 0 and m.handle_id in (${hs.join(',')}))` : '',
    ]
      .filter(Boolean)
      .join(' or ');
    const empty: PersonActivity = {
      messageCount: 0,
      sentByMe: 0,
      sentByThem: 0,
      dmChatIds,
      groupChatIds,
      byMonth: {},
      daysStarted: { you: 0, them: 0 },
    };
    if (!cond) return empty;
    const hidden = notHidden(this.ctx.dir);
    const rows = this.ctx.db
      .prepare(
        `select m.ROWID r, m.is_from_me me, cmj.chat_id c, ${SQL_MS('m.date')} d from message m ${AGG_JOIN} where ${REAL()} and (${cond}) ${hidden && `and ${hidden}`} order by m.date`,
      )
      .all() as Row[];
    if (!rows.length) return empty;
    const dmSet = new Set(dmRowids);
    const byMonth: Record<string, number> = {};
    let you = 0,
      them = 0,
      lastDay = '',
      mine = 0,
      dmMessageCount = 0,
      sentByThemInGroups = 0,
      lastMeRow = 0,
      lastThemRow = 0;
    for (const r of rows) {
      const lp = localParts(Number(r.d) + APPLE_EPOCH_MS, this.ctx.cfg.tools.timeZone);
      const k = `${lp.y}-${String(lp.mo).padStart(2, '0')}`;
      byMonth[k] = (byMonth[k] ?? 0) + 1;
      if (r.me) mine++;
      const dm = dmSet.has(Number(r.c));
      if (dm) {
        dmMessageCount++;
        const day = `${lp.y}-${lp.mo}-${lp.d}`;
        if (day !== lastDay) {
          lastDay = day;
          if (r.me) you++;
          else them++;
        }
      } else if (!r.me) sentByThemInGroups++;
      if (r.me && dm) lastMeRow = Number(r.r);
      if (!r.me) lastThemRow = Number(r.r);
    }
    return {
      messageCount: rows.length,
      sentByMe: mine,
      sentByThem: rows.length - mine,
      firstAt: Number(rows[0].d) + APPLE_EPOCH_MS,
      last: this.reader.message(`m${rows[rows.length - 1].r}`),
      dmChatIds,
      groupChatIds,
      byMonth,
      daysStarted: { you, them },
      dmMessageCount,
      sentByThemInGroups,
      lastFromMe: lastMeRow ? this.reader.message(`m${lastMeRow}`) : undefined,
      lastFromThem: lastThemRow ? this.reader.message(`m${lastThemRow}`) : undefined,
    };
  }

  chatActivity(chatId: string): ChatActivity {
    const chat = this.ctx.dir.chatRec(chatId);
    if (!chat) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    const base = `from message m join chat_message_join cmj on cmj.message_id = m.ROWID where cmj.chat_id = ${chat.rowid}`;
    const bySender: Record<string, number> = {};
    for (const r of this.ctx.db
      .prepare(
        `select m.is_from_me me, m.handle_id h, count(*) n ${base} and ${REAL()} group by m.is_from_me, m.handle_id`,
      )
      .all() as Row[]) {
      const id = r.me
        ? ME
        : (this.ctx.dir.personIdByKey.get(this.ctx.dir.handleKeyByRowid.get(Number(r.h)) ?? '') ??
          (chat.type === 'dm' ? (chat.participantIds[0] ?? 'unknown') : 'unknown'));
      bySender[id] = (bySender[id] ?? 0) + Number(r.n);
    }
    const agg = this.ctx
      .big(
        `select count(*) n, min(m.date) first, sum(m.date >= ?) recent, sum(m.cache_has_attachments) atts, sum(m.balloon_bundle_id = '${URL_BALLOON}') links ${base} and ${REAL()}`,
      )
      .get(toAppleNs(Date.now() - 30 * DAY_MS)) as {
      n: bigint;
      first: bigint | null;
      recent: bigint | null;
      atts: bigint | null;
      links: bigint | null;
    };
    const events = this.hydrator
      .hydrate(
        this.ctx.db
          .prepare(
            `select ${MSG_COLS}, cmj.chat_id chat_rowid ${base} and m.item_type in (1,2,3) order by m.date desc limit 200`,
          )
          .all() as MsgRow[],
      )
      .reverse();
    return {
      total: Number(agg.n),
      firstAt: agg.first ? fromAppleNs(agg.first) : undefined,
      bySender,
      last30Days: Number(agg.recent ?? 0),
      attachments: Number(agg.atts ?? 0),
      links: Number(agg.links ?? 0),
      groupEvents: events,
    };
  }

  stats(groupBy: StatGroup, metric: StatMetric, filter: MessageFilter): StatRow[] {
    // An explicit from wins over the one the metric implies.
    const from: MessageFilter['from'] =
      filter.from ?? (metric === 'sent' ? { kind: 'me' } : metric === 'received' ? { kind: 'others' } : undefined);
    const f: MessageFilter = {
      ...filter,
      ...(from ? { from } : {}),
      ...(metric === 'attachments' ? { hasAttachment: true } : {}),
    };
    const w = messageWhere(this.ctx.dir, f);
    const rows = this.ctx.db
      .prepare(
        `select m.is_from_me me, m.handle_id h, cmj.chat_id c, ${SQL_MS('m.date')} d from message m ${AGG_JOIN} where ${REAL()} and ${w.sql.join(' and ')}`,
      )
      .all(...w.params) as Row[];
    const input = rows
      .map((r) => {
        const chat = this.ctx.dir.chatsByRowid.get(Number(r.c));
        return {
          senderId: r.me
            ? ME
            : (this.ctx.dir.personIdByKey.get(this.ctx.dir.handleKeyByRowid.get(Number(r.h)) ?? '') ?? 'unknown'),
          chatId: chat?.chatId ?? 'unknown',
          chatType: chat?.type ?? 'dm',
          dmPartner: chat?.type === 'dm' ? chat.participantIds[0] : undefined,
          sentAt: Number(r.d) + APPLE_EPOCH_MS,
        };
      })
      .filter((x) => x.chatId !== 'unknown');
    return groupStats(
      input,
      groupBy,
      this.ctx.cfg.tools.timeZone,
      (id) => this.ctx.dir.personName(id),
      (id) => {
        const c = this.ctx.dir.chatsByGuid.get(id);
        return c ? this.ctx.dir.chatTitle(c) : id;
      },
    );
  }

  counts() {
    const hidden = notHidden(this.ctx.dir);
    const n = Number(
      (
        this.ctx.db
          .prepare(
            `select count(*) n from message m join chat_message_join cmj on cmj.message_id = m.ROWID where ${REAL()} ${hidden && `and ${hidden}`}`,
          )
          .get() as Row
      ).n,
    );
    return { people: this.ctx.dir.peopleById.size, chats: this.summaries.chatSummaries().length, messages: n };
  }
}
