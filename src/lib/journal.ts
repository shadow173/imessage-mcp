import type { DatabaseSync } from 'node:sqlite';

/** One tool call as the owner will want to study it later: who called, why (intent), what, and how it went. */
export interface JournalEntry {
  at: number;
  client: string;
  tool: string;
  intent: string | null;
  args: Record<string, unknown>;
  ok: boolean;
  errorCode?: string;
  /** First 300 characters of the error the model saw, to study where calls go wrong. */
  error?: string;
  ms: number;
  outChars: number;
}

export type JournalSink = (e: JournalEntry) => void;

/** Keeps arguments readable: drops intent (stored separately), shortens long strings, replaces file contents. */
export function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      if (/base64|image_base64/.test(key)) return `[file ${Math.round((v.length * 0.75) / 1024)} KB]`;
      return v.length > 500 ? `${v.slice(0, 500)}… [+${v.length - 500} chars]` : v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  const { intent: _intent, ...rest } = args;
  return walk(rest) as Record<string, unknown>;
}

/** A short, stable label for whoever is calling: chatgpt, claude, claude-code, local, or the registered client name. */
export function clientLabel(clientId: string | undefined): string {
  if (!clientId) return 'unknown';
  if (clientId.startsWith('local')) return clientId;
  if (clientId.includes('chatgpt.com')) return 'chatgpt';
  if (clientId.includes('claude-code')) return 'claude-code';
  if (clientId.includes('claude.ai') || clientId.includes('claude.com')) return 'claude';
  const parts = clientId.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { n?: string; r?: string[] };
      const redirects = (payload.r ?? []).join(' ');
      if (redirects.includes('chatgpt.com')) return 'chatgpt';
      if (redirects.includes('claude.ai') || redirects.includes('claude.com')) return 'claude';
      if (payload.n) return payload.n.toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    } catch {
      /* not a client token */
    }
  }
  return 'client';
}

/** A tool_calls row as node:sqlite returns it. */
type ToolCallRow = {
  id: number;
  at: number;
  client: string;
  tool: string;
  intent: string | null;
  args: string;
  ok: number;
  error_code: string | null;
  error: string | null;
  ms: number;
  out_chars: number;
};

/** Tool-call journal in the bridge's sidecar database, on this Mac only. */
export class Journal {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, client TEXT NOT NULL, tool TEXT NOT NULL, intent TEXT, args TEXT NOT NULL, ok INTEGER NOT NULL, error_code TEXT, error TEXT, ms INTEGER NOT NULL, out_chars INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tool_calls_at ON tool_calls(at);`);
  }

  sink: JournalSink = (e) => {
    try {
      this.db
        .prepare(
          'insert into tool_calls(at, client, tool, intent, args, ok, error_code, error, ms, out_chars) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          e.at,
          e.client,
          e.tool,
          e.intent,
          JSON.stringify(e.args),
          e.ok ? 1 : 0,
          e.errorCode ?? null,
          e.error ?? null,
          e.ms,
          e.outChars,
        );
    } catch {
      /* never let journaling break a tool call */
    }
  };

  list(o: { since?: number; limit?: number; client?: string; tool?: string }): (JournalEntry & { id: number })[] {
    const where = ['at >= ?'];
    const params: (string | number)[] = [o.since ?? 0];
    if (o.client) {
      where.push('client = ?');
      params.push(o.client);
    }
    if (o.tool) {
      where.push('tool = ?');
      params.push(o.tool);
    }
    const rows = this.db
      .prepare(`select * from tool_calls where ${where.join(' and ')} order by at desc limit ?`)
      .all(...params, Math.min(o.limit ?? 200, 5000)) as ToolCallRow[];
    return rows.reverse().map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      client: String(r.client),
      tool: String(r.tool),
      intent: r.intent,
      args: JSON.parse(r.args),
      ok: !!r.ok,
      errorCode: r.error_code ?? undefined,
      error: r.error ?? undefined,
      ms: Number(r.ms),
      outChars: Number(r.out_chars),
    }));
  }

  /** Deletes calls made before `before` (epoch ms) and returns how many, for a retention sweep. */
  prune(before: number): number {
    return Number(this.db.prepare('delete from tool_calls where at < ?').run(before).changes);
  }
}
