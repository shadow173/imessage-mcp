import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DAY_MS } from '../lib/units.js';
import { stemWord } from '../store/match.js';

/** Finished idempotency keys are kept this long; agents retry within minutes. */
const IDEMPOTENCY_KEEP_MS = 7 * DAY_MS;

type Migration = (db: DatabaseSync) => void;

/** Adds the columns a table doesn't have yet (CREATE TABLE IF NOT EXISTS leaves older installs alone). */
function addColumns(db: DatabaseSync, table: string, cols: Record<string, string>) {
  const have = new Set((db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of Object.entries(cols))
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

/**
 * Schema changes, in order; PRAGMA user_version counts how many have run. Each one is safe to run on a database that
 * already has its change (a fresh one created by the CREATE statements, or one from before user_version was kept).
 */
const MIGRATIONS: Migration[] = [
  // 1: draft columns added after the first release.
  (db) =>
    addColumns(db, 'drafts', {
      error: 'TEXT',
      confirmed: 'INTEGER NOT NULL DEFAULT 0',
      attempts: 'INTEGER NOT NULL DEFAULT 0',
      reply_to: 'TEXT',
      effect: 'TEXT',
      attachments: 'TEXT',
    }),
  // 2: reminders say when they dismiss as text. dismiss_on_reply (0 never, 1 they_reply, 2 i_reply) is still written
  // for older bridges reading the same file.
  (db) => {
    for (const table of ['reminders', 'reminder_dismissals']) {
      addColumns(db, table, { dismiss_when: 'TEXT' });
      db.exec(`UPDATE ${table} SET dismiss_when = CASE dismiss_on_reply WHEN 0 THEN 'never' WHEN 2 THEN 'i_reply' ELSE 'they_reply' END
        WHERE dismiss_when IS NULL`);
    }
  },
  // 3: the boot of the bridge sending a draft right now, so one interrupted by a restart is never sent twice.
  (db) => addColumns(db, 'drafts', { sending_boot: 'TEXT' }),
];

/**
 * The bridge's own database, next to chat.db but never inside it:
 * a contentless FTS5 index (no message text stored), filter metadata, and everything the owner or agent
 * creates (aliases, notes, labels, reminders, drafts, idempotency keys, audit log).
 */
export class Sidecar {
  readonly db: DatabaseSync;

  /** retentionDays: how long the audit log and the tool-call journal keep rows. */
  constructor(
    dataDir: string,
    private retentionDays = 30,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'sidecar.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS msg_meta (rowid INTEGER PRIMARY KEY, chat_rowid INTEGER, handle_id INTEGER, from_me INTEGER, date_ms INTEGER, has_att INTEGER, is_link INTEGER);
      CREATE INDEX IF NOT EXISTS msg_meta_chat ON msg_meta(chat_rowid, date_ms);
      CREATE INDEX IF NOT EXISTS msg_meta_date ON msg_meta(date_ms);
      CREATE TABLE IF NOT EXISTS person_meta (person_id TEXT PRIMARY KEY, aliases TEXT NOT NULL DEFAULT '[]', note TEXT, labels TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS chat_labels (chat_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (chat_id, label));
      CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL UNIQUE, remind_at INTEGER NOT NULL, note TEXT,
        dismiss_on_reply INTEGER NOT NULL, created_at INTEGER NOT NULL, dismiss_when TEXT);
      CREATE TABLE IF NOT EXISTS reminder_dismissals (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, remind_at INTEGER NOT NULL, note TEXT,
        dismiss_on_reply INTEGER NOT NULL, created_at INTEGER NOT NULL, dismissed_at INTEGER NOT NULL, dismissed_by TEXT, dismiss_when TEXT);
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, chat_id TEXT, to_address TEXT, text TEXT NOT NULL, send_at INTEGER,
        note TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, sent_message_id TEXT, error TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, reply_to TEXT, effect TEXT, attachments TEXT,
        sending_boot TEXT);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, chat_id TEXT, detail TEXT);
    `);
    this.migrate();
  }

  /** Runs the migrations this file hasn't had yet, each in its own transaction. */
  private migrate() {
    const done = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    for (let v = done; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        MIGRATIONS[v](this.db);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  /**
   * Drops finished idempotency keys after 7 days (pending ones stay, so a late retry is never sent twice), and audit and
   * tool-call journal rows after retentionDays.
   */
  prune(now = Date.now()) {
    this.db
      .prepare(`delete from idempotency where created_at < ? and instr(result, '"pending":true') = 0`)
      .run(now - IDEMPOTENCY_KEEP_MS);
    const cutoff = now - this.retentionDays * DAY_MS;
    this.db.prepare('delete from audit where at < ?').run(cutoff);
    // The journal creates tool_calls on this same file, after the store starts.
    if (this.db.prepare("select 1 from sqlite_master where type = 'table' and name = 'tool_calls'").get())
      this.db.prepare('delete from tool_calls where at < ?').run(cutoff);
  }

  get(k: string): string | undefined {
    return (this.db.prepare('select v from kv where k = ?').get(k) as { v: string } | undefined)?.v;
  }
  set(k: string, v: string | number) {
    this.db.prepare('insert into kv(k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, String(v));
  }

  audit(action: string, chatId: string | null, detail: Record<string, unknown>) {
    this.db
      .prepare('insert into audit(at, action, chat_id, detail) values (?, ?, ?, ?)')
      .run(Date.now(), action, chatId, JSON.stringify(detail));
  }
}

function ftsParts(q: string, stem: boolean): string[] {
  const parts: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const raw = (m[1] ?? m[2]).replace(/"/g, '').trim();
    if (!raw) continue;
    if (m[1]) {
      parts.push(`"${raw}"`);
      continue;
    }
    let word = raw.replace(/[^\p{L}\p{N}'_-]/gu, '');
    if (stem && /^[\p{L}]+$/u.test(word)) word = stemWord(word);
    if (!word) continue;
    parts.push(word.length >= 3 ? `"${word}"*` : `"${word}"`);
  }
  return parts;
}

/**
 * Turns a user query into FTS5 syntax: every word must appear, words of 3+ chars match as prefixes, "quoted phrases"
 * stay whole.
 */
export function ftsQuery(q: string): string | null {
  const parts = ftsParts(q, false);
  return parts.length ? parts.join(' ') : null;
}

/** match=any: the same parts OR-ed, with plain words stemmed, for closest-match fallbacks ranked by bm25. */
export function ftsQueryAny(q: string): string | null {
  const parts = ftsParts(q, true);
  return parts.length ? parts.join(' OR ') : null;
}
