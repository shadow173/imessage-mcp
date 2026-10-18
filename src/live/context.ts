// What every part of the live store shares, opened once by LiveStore.

import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { BridgeConfig } from '../config.js';
import { Directory } from './directory.js';
import { Sidecar } from './sidecar.js';

export interface LiveContext {
  /** chat.db, read-only. */
  readonly db: DatabaseSync;
  /** The bridge's own database: search index, organizer data, idempotency keys, journal. */
  readonly side: Sidecar;
  readonly cfg: BridgeConfig;
  readonly dir: Directory;
  /** A prepared statement kept for reuse, for hot single-row lookups. */
  stmt(sql: string): StatementSync;
  /** A statement that returns integers as BigInt, for raw nanosecond columns past 2^53. */
  big(sql: string): StatementSync;
}

/** Opens chat.db read-only, or says which permission is missing. */
function openChatDb(path: string): DatabaseSync {
  if (!existsSync(path))
    throw new Error(
      `Can't see chat.db at ${path}. Grant Full Disk Access to the program running the bridge (or check the path).`,
    );
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.prepare('select count(*) from message limit 1').get();
  } catch (e) {
    throw new Error(
      `Can't read chat.db (${(e as Error).message}). Grant Full Disk Access to the program running the bridge.`,
    );
  }
  db.exec(
    'PRAGMA query_only = 1; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -65536; PRAGMA mmap_size = 536870912;',
  );
  return db;
}

/** Opens chat.db and the sidecar. The directory starts empty; LiveStore loads it. */
export function openLiveContext(cfg: BridgeConfig): LiveContext {
  const db = openChatDb(cfg.chatDbPath);
  const side = new Sidecar(cfg.dataDir);
  const stmts = new Map<string, StatementSync>();
  return {
    db,
    side,
    cfg,
    dir: new Directory(db, side, cfg),
    stmt(sql) {
      let s = stmts.get(sql);
      if (!s) {
        s = db.prepare(sql);
        stmts.set(sql, s);
      }
      return s;
    },
    big(sql) {
      const st = db.prepare(sql);
      st.setReadBigInts(true);
      return st;
    },
  };
}
