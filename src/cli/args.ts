// Command-line parsing: positionals, --flags (with or without a value), repeated flags, and CLI durations.

import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '../lib/units.js';
import { CliError, EXIT } from './errors.js';

/** Flags that never take a value, so the word after them stays a positional. */
export const BOOL_FLAGS = new Set([
  'json',
  'receipts',
  'errors',
  'unread',
  'needs-reply',
  'groups',
  'dms',
  'all-senders',
  'confirm',
  'sms',
  'remove',
  'stop',
  'once',
  'include-mine',
  'events',
  'has-attachment',
  'has-link',
  'text',
  'link',
  'info',
  'help',
  'h',
  'clear',
  'oldest',
  'no-needs-reply',
]);

export interface Parsed {
  pos: string[];
  flags: Record<string, string | true>;
  /** Every value of a flag given more than once (--file a --file b). */
  multi: Record<string, string[]>;
}

export function parse(argv: string[]): Parsed {
  const p: Parsed = { pos: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      p.pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      const next = argv[i + 1];
      const takesNext = inline === undefined && next !== undefined && !next.startsWith('--') && !BOOL_FLAGS.has(k);
      if (takesNext) i++;
      const val = inline ?? (takesNext ? next : true);
      p.flags[k] = val;
      if (typeof val === 'string') (p.multi[k] ??= []).push(val);
    } else p.pos.push(a);
  }
  return p;
}

export const str = (p: Parsed, k: string) => (typeof p.flags[k] === 'string' ? (p.flags[k] as string) : undefined);
export const num = (p: Parsed, k: string) => (str(p, k) !== undefined ? Number(str(p, k)) : undefined);
export const bool = (p: Parsed, k: string) => (p.flags[k] === true ? true : undefined);
/** The positionals from index `from` on, joined with spaces (names and texts don't need quotes). */
export const rest = (p: Parsed, from: number) => p.pos.slice(from).join(' ').trim();
export function need(v: string | undefined, usage: string): string {
  if (!v) throw new CliError(`Usage: imessage ${usage}`, EXIT.usage);
  return v;
}
/** --json asks the tool for JSON too. */
export const fmt = (p: Parsed) => (p.flags.json ? 'json' : undefined);

/**
 * A CLI-local duration (--timeout, journal --since). No months here, so a bare m stays minutes; min matches the tools'
 * spelling.
 */
export function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|d|w)?$/i);
  if (!m) throw new CliError(`Can't read the duration "${s}". Use 90s, 30min, 2h, 1d or 1w.`, EXIT.usage);
  const unit = (m[2] ?? 's').toLowerCase();
  return (
    Number(m[1]) *
    ({ s: SECOND_MS, sec: SECOND_MS, m: MINUTE_MS, min: MINUTE_MS, h: HOUR_MS, d: DAY_MS, w: 7 * DAY_MS }[unit] ??
      SECOND_MS)
  );
}
