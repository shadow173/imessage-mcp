// Daily cleanup on the bridge.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DAY_MS } from '../lib/units.js';
import type { LiveContext } from './context.js';
import { escLike, type Row } from './sql.js';

/** Staged attachment folders older than this are removed unless chat.db still points into them. */
const STAGE_KEEP_MS = 7 * DAY_MS;

/**
 * Daily housekeeping: prunes old sidecar rows, and removes staged attachment folders older than a week that no
 * attachment in chat.db points into (when Messages keeps the staged file itself, it stays).
 */
export function sweep(ctx: LiveContext) {
  try {
    ctx.side.prune();
    const root = resolve(ctx.cfg.attachmentsStageDir);
    if (!existsSync(root)) return;
    const old = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && Date.now() - statSync(join(root, e.name)).mtimeMs > STAGE_KEEP_MS)
      .map((e) => e.name);
    if (!old.length) return;
    // chat.db may record the path from ~; LIKE ignores case, and so does this comparison.
    const home = process.env.HOME ?? homedir();
    const prefixes = [root, ...(root.startsWith(`${home}/`) ? [`~${root.slice(home.length)}`] : [])].map(
      (p) => `${p.toLowerCase()}/`,
    );
    const used = new Set<string>();
    for (const r of ctx.db
      .prepare(
        `select filename f from attachment where ${prefixes.map(() => "filename like ? escape '\\'").join(' or ')}`,
      )
      .all(...prefixes.map((p) => `${escLike(p)}%`)) as Row[]) {
      const f = String(r.f).toLowerCase();
      const prefix = prefixes.find((p) => f.startsWith(p));
      if (prefix) used.add(f.slice(prefix.length).split('/')[0]);
    }
    for (const name of old)
      if (!used.has(name.toLowerCase())) rmSync(join(root, name), { recursive: true, force: true });
  } catch (e) {
    console.error('housekeeping failed:', (e as Error).message);
  }
}
