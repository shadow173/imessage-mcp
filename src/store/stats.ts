import { localParts, zonedToUtc } from '../lib/time.js';
import { ME, type StatGroup, type StatRow } from './types.js';

export interface StatInput {
  senderId: string;
  chatId: string;
  chatType: 'dm' | 'group';
  dmPartner?: string;
  sentAt: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Groups already-filtered messages. Shared by every store so results match across mock and live. */
export function groupStats(
  rows: Iterable<StatInput>,
  groupBy: StatGroup,
  tz: string,
  labelPerson: (id: string) => string,
  labelChat: (id: string) => string,
): StatRow[] {
  const counts = new Map<string, { label: string; value: number }>();
  const bump = (key: string, label: () => string) => {
    const c = counts.get(key);
    if (c) c.value++;
    else counts.set(key, { label: label(), value: 1 });
  };
  for (const r of rows) {
    if (groupBy === 'person') {
      // Your 1:1 messages count for the other person; your group messages get their own row (callers may drop it).
      if (r.senderId === ME && r.chatType === 'group') {
        bump(ME, () => 'You (group chats)');
        continue;
      }
      const pid = r.senderId !== ME ? r.senderId : r.dmPartner;
      if (pid) bump(pid, () => labelPerson(pid));
      continue;
    }
    if (groupBy === 'chat') {
      bump(r.chatId, () => labelChat(r.chatId));
      continue;
    }
    const lp = localParts(r.sentAt, tz);
    if (groupBy === 'month') {
      const k = `${lp.y}-${pad(lp.mo)}`;
      bump(k, () => k);
    } else if (groupBy === 'weekday') bump(String(WEEKDAYS.indexOf(lp.weekday)), () => lp.weekday);
    else bump(pad(lp.h), () => `${pad(lp.h)}:00`);
  }
  return [...counts.entries()].map(([key, v]) => ({ key, label: v.label, value: v.value }));
}

/**
 * Adds the zero rows: hours 00-23, weekdays 0-6, and every month from `from` to `to` (exclusive end, owner's zone).
 * Months the window cuts get partial: true. Without a usable `from` (0 or NaN) months start at the earliest row,
 * unflagged.
 */
export function fillStatRows(
  rows: StatRow[],
  groupBy: StatGroup,
  window: { from: number; to: number },
  tz: string,
): StatRow[] {
  const have = new Map(rows.map((r) => [r.key, r]));
  const row = (key: string, label: string): StatRow => have.get(key) ?? { key, label, value: 0 };
  if (groupBy === 'hour') return Array.from({ length: 24 }, (_, h) => row(pad(h), `${pad(h)}:00`));
  if (groupBy === 'weekday') return WEEKDAYS.map((d, i) => row(String(i), d));
  if (groupBy !== 'month') return rows;
  const known = Number.isFinite(window.from) && window.from > 0;
  const keys = rows
    .map((r) => r.key)
    .filter((k) => /^\d{4}-\d\d$/.test(k))
    .sort();
  if (!known && !keys.length) return rows;
  const toKey = (ms: number) => {
    const p = localParts(ms, tz);
    return `${p.y}-${pad(p.mo)}`;
  };
  const start = known ? toKey(window.from) : keys[0];
  const endMs = Math.max(known ? window.from : 0, window.to - 1);
  const end = Number.isFinite(endMs) && endMs > 0 ? toKey(endMs) : keys[keys.length - 1];
  const monthStart = (y: number, mo: number) => zonedToUtc(y, mo, 1, 0, 0, tz);
  const out: StatRow[] = [];
  let [y, mo] = start.split('-').map(Number);
  for (let guard = 0; guard < 2400; guard++) {
    const key = `${y}-${pad(mo)}`;
    if (key > end) break;
    const r = { ...row(key, key) };
    const ny = mo === 12 ? y + 1 : y,
      nmo = mo === 12 ? 1 : mo + 1;
    if ((known && key === start && window.from > monthStart(y, mo)) || (key === end && window.to < monthStart(ny, nmo)))
      r.partial = true;
    out.push(r);
    y = ny;
    mo = nmo;
  }
  const inRange = new Set(out.map((r) => r.key));
  return [...out, ...rows.filter((r) => !inRange.has(r.key))];
}
