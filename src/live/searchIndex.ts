// The search index in the sidecar: a contentless FTS5 table over message text, link titles and attachment names,
// built in the background on first start and kept current as messages arrive or change.

import type { AttachmentKind } from '../domain/attachments.js';
import { chunks } from '../lib/collections.js';
import { ToolError } from '../lib/errors.js';
import { redact } from '../policy/redact.js';
import { normDomain, wordTokens } from '../store/match.js';
import { type ListPage, ME, type Message, type MessageFilter } from '../store/types.js';
import { APPLE_EPOCH_MS } from './appleTime.js';
import type { AttachmentCatalog } from './attachmentCatalog.js';
import type { LiveContext } from './context.js';
import { type Hydrator, readRichLink } from './hydrate.js';
import { ftsQuery, ftsQueryAny } from './sidecar.js';
import {
  INDEX_SCOPE,
  MIN_CHAT_JOIN,
  MSG_COLS,
  type MsgRow,
  REAL,
  type Row,
  SQL_MS,
  scopeWhere,
  sqlCount,
  URL_BALLOON,
  type Where,
} from './sql.js';
import { cleanText, decodeAttributedBody } from './typedstream.js';

/**
 * Bump to rebuild the search index; 'r' marks an index built with codes redacted, so flipping REDACT_CODES rebuilds it
 * too.
 */
// 3: link titles are redacted too, so an index built by an older bridge is rebuilt once.
const ftsVersion = (redactCodes: boolean) => `3${redactCodes ? 'r' : ''}`;

/** A row of indexSelect(). */
type IndexRow = {
  rowid: number;
  text: string | null;
  body: Uint8Array | null;
  balloon_bundle_id: string | null;
  payload: Uint8Array | null;
  cache_has_attachments: number;
  handle_id: number;
  is_from_me: number;
  date_ms: number;
  chat_rowid: number;
};

export class SearchIndex {
  private fts: { total: number; done: number; ready: boolean; error?: string } = { total: 0, done: 0, ready: false };

  constructor(
    private ctx: LiveContext,
    private hydrator: Hydrator,
    private catalog: AttachmentCatalog,
  ) {}

  /** Builds the index in the background; a failure is kept for status(), search() and health instead of thrown. */
  start() {
    this.build().catch((e) => {
      this.fts.error = String((e as Error)?.message ?? e);
      console.error('search index build failed:', e);
    });
  }

  /** Re-indexes rows that arrived or changed since the build (nothing until the first build is done). */
  reindex(ids: number[]) {
    if (!this.fts.ready) return;
    for (const chunk of chunks(ids, 500))
      this.indexRows(this.ctx.db.prepare(this.indexSelect(`m.ROWID in (${chunk.join(',')})`)).all() as IndexRow[]);
    if (ids.length)
      this.ctx.side.set('fts_last_rowid', Math.max(Number(this.ctx.side.get('fts_last_rowid') ?? 0), ...ids));
  }

  /** Indexes every message after the last one indexed, 2000 rows at a time, yielding between batches. */
  async build() {
    const version = ftsVersion(this.ctx.cfg.tools.redactCodes);
    if (this.ctx.side.get('fts_version') !== version) {
      this.ctx.side.db.exec('delete from msg_fts; delete from msg_meta;');
      this.ctx.side.set('fts_version', version);
      this.ctx.side.set('fts_last_rowid', 0);
    }
    let last = Number(this.ctx.side.get('fts_last_rowid') ?? 0);
    const max = Number((this.ctx.db.prepare('select max(ROWID) r from message').get() as Row).r ?? 0);
    this.fts.total = Math.max(1, max);
    this.fts.done = last;
    const sel = this.ctx.db.prepare(`${this.indexSelect('m.ROWID > ?')} order by m.ROWID limit 2000`);
    while (true) {
      const rows = sel.all(last) as IndexRow[];
      if (!rows.length) break;
      this.indexRows(rows);
      last = Number(rows[rows.length - 1].rowid);
      this.ctx.side.set('fts_last_rowid', last);
      this.fts.done = last;
      await new Promise((r) => setImmediate(r));
    }
    this.fts.done = this.fts.total;
    this.fts.ready = true;
  }

  status() {
    return {
      ready: this.fts.ready,
      percent: this.fts.total ? Math.floor((this.fts.done / this.fts.total) * 100) : 0,
      ...(this.fts.error ? { error: this.fts.error } : {}),
    };
  }

  search(
    filter: MessageFilter & { text: string },
    o: { sort: 'relevance' | 'newest' | 'oldest'; limit: number; offset: number; match?: 'all' | 'any' },
  ): ListPage {
    if (this.fts.error)
      throw new ToolError(
        'index_failed',
        "The search index couldn't be built on the Mac, so message text can't be searched.",
        'Tell the user; the bridge log says why, and restarting the bridge retries. Meanwhile list_conversations, read_conversation and get_person still work.',
      );
    if (!this.fts.ready) {
      const pct = this.fts.total ? Math.floor((this.fts.done / this.fts.total) * 100) : 0;
      throw new ToolError(
        'index_building',
        `The search index is still being built (${pct}%).`,
        'Try again in a few minutes. Every other tool works now: list_conversations, read_conversation and get_person can find most things without search.',
      );
    }
    const limit = sqlCount(o.limit, 'limit'),
      offset = sqlCount(o.offset, 'offset');
    const any = o.match === 'any';
    let q = any ? ftsQueryAny(filter.text) : ftsQuery(filter.text);
    if (!q) return { items: [], total: 0 };
    // Link filters: their words (and the site's host as a phrase) must be in the indexed text, on a link message.
    const hostWords = filter.linkDomain ? wordTokens(normDomain(filter.linkDomain)) : [];
    const linkParts = [
      filter.linkQuery ? ftsQuery(filter.linkQuery) : null,
      hostWords.length ? `"${hostWords.join(' ')}"` : null,
    ].filter(Boolean);
    if (linkParts.length) q = `(${q}) AND ${linkParts.join(' AND ')}`;
    const w: Where = { sql: ['msg_fts match ?'], params: [q] };
    if (filter.linkQuery || filter.linkDomain) w.sql.push('mm.is_link = 1');
    const { sql: conds, params } = scopeWhere(this.ctx.dir, filter, INDEX_SCOPE, w);
    if (filter.hasAttachment !== undefined) conds.push(`mm.has_att = ${filter.hasAttachment ? 1 : 0}`);
    if (filter.hasLink !== undefined) conds.push(`mm.is_link = ${filter.hasLink ? 1 : 0}`);
    const order =
      o.sort === 'relevance'
        ? 'bm25(msg_fts), mm.date_ms desc'
        : o.sort === 'newest'
          ? 'mm.date_ms desc'
          : 'mm.date_ms asc';
    const sql = `from msg_fts join msg_meta mm on mm.rowid = msg_fts.rowid where ${conds.join(' and ')}`;
    let ids: number[];
    let total: number;
    try {
      ids = (
        this.ctx.side.db
          .prepare(`select msg_fts.rowid r ${sql} order by ${order} limit ? offset ?`)
          .all(...params, limit, offset) as Row[]
      ).map((r) => Number(r.r));
      total = Number((this.ctx.side.db.prepare(`select count(*) n ${sql}`).get(...params) as Row).n);
    } catch {
      throw new ToolError(
        'bad_query',
        `Couldn't search for "${filter.text}".`,
        'Use plain words, or quote an exact phrase.',
      );
    }
    if (!ids.length) return { items: [], total };
    const rows = this.ctx.db
      .prepare(
        `select ${MSG_COLS}, cmj.chat_id chat_rowid from message m ${MIN_CHAT_JOIN} where m.ROWID in (${ids.join(',')})`,
      )
      .all() as MsgRow[];
    const byId = new Map(this.hydrator.hydrate(rows).map((m) => [m.messageId, m]));
    let items = ids.map((id) => byId.get(`m${id}`)).filter(Boolean) as Message[];
    if (filter.unreadOnly) items = items.filter((m) => m.senderId !== ME && !m.isRead);
    if (filter.attachmentKinds?.length)
      items = items.filter((m) =>
        m.attachmentIds.some((a) => filter.attachmentKinds!.includes(this.catalog.get(a)?.kind as AttachmentKind)),
      );
    return { items, total };
  }

  private indexRows(rows: IndexRow[]) {
    const ins = this.ctx.side.db.prepare('insert into msg_fts(rowid, body) values (?, ?)');
    const del = this.ctx.side.db.prepare('delete from msg_fts where rowid = ?');
    const meta = this.ctx.side.db.prepare(
      `insert into msg_meta(rowid, chat_rowid, handle_id, from_me, date_ms, has_att, is_link) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(rowid) do update set chat_rowid = excluded.chat_rowid, has_att = excluded.has_att, is_link = excluded.is_link`,
    );
    const names = new Map<number, string>();
    const withAtt = rows.filter((r) => r.cache_has_attachments).map((r) => Number(r.rowid));
    for (const chunk of chunks(withAtt, 800))
      for (const a of this.ctx.db
        .prepare(
          `select maj.message_id mid, group_concat(a.transfer_name, ' ') n
          from message_attachment_join maj join attachment a on a.ROWID = maj.attachment_id
          where maj.message_id in (${chunk.join(',')}) and coalesce(a.transfer_name, '') not like '%.pluginPayloadAttachment'
          group by maj.message_id`,
        )
        .all() as Row[])
        names.set(Number(a.mid), String(a.n ?? ''));
    this.ctx.side.db.exec('BEGIN');
    try {
      for (const r of rows) {
        // Codes are left out of the index too, so a search can't confirm a hidden code's digits.
        const text = cleanText(r.text != null ? String(r.text) : (decodeAttributedBody(r.body) ?? ''));
        const hide = (t: string) =>
          redact(
            t,
            r.is_from_me ? undefined : this.ctx.dir.addressForIndex(Number(r.handle_id)),
            this.ctx.cfg.tools.redactCodes,
            {
              replacement: ' ',
            },
          );
        let body = hide(text);
        if (r.balloon_bundle_id === URL_BALLOON && r.payload) {
          try {
            const { title } = readRichLink(r.payload);
            if (title !== undefined) body += ` ${hide(title)}`;
          } catch {
            /* no title */
          }
        }
        const n = names.get(Number(r.rowid));
        if (n) body += ` ${n}`;
        del.run(Number(r.rowid));
        if (body.trim()) ins.run(Number(r.rowid), body);
        meta.run(
          Number(r.rowid),
          Number(r.chat_rowid ?? 0),
          Number(r.handle_id ?? 0),
          Number(r.is_from_me),
          Number(r.date_ms) + APPLE_EPOCH_MS,
          Number(r.cache_has_attachments) ? 1 : 0,
          r.balloon_bundle_id === URL_BALLOON ? 1 : 0,
        );
      }
      this.ctx.side.db.exec('COMMIT');
    } catch (e) {
      this.ctx.side.db.exec('ROLLBACK');
      throw e;
    }
  }

  private indexSelect(cond: string) {
    return `select m.ROWID rowid, m.text, m.attributedBody body, m.balloon_bundle_id, m.payload_data payload, m.cache_has_attachments, m.handle_id, m.is_from_me, ${SQL_MS('m.date')} date_ms, cmj.chat_id chat_rowid
      from message m ${MIN_CHAT_JOIN} where ${REAL()} and ${cond}`;
  }
}
