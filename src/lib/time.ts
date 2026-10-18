import { ToolError } from './errors.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './units.js';

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  weekday: string;
}

function slowParts(ms: number, tz: string): LocalParts {
  const p = partsFmt(tz).formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '0';
  return {
    y: +get('year'),
    mo: +get('month'),
    d: +get('day'),
    h: +get('hour'),
    mi: +get('minute'),
    s: +get('second'),
    weekday: get('weekday'),
  };
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const offsetCache = new Map<string, Map<number, number>>();
const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** Wall-clock parts in tz. Caches the zone offset per 15-minute bucket, so scanning 200k rows stays fast. */
export function localParts(ms: number, tz: string): LocalParts {
  let cache = offsetCache.get(tz);
  if (!cache) {
    cache = new Map();
    offsetCache.set(tz, cache);
  }
  const bucket = Math.floor(ms / 900_000);
  let off = cache.get(bucket);
  if (off === undefined) {
    const p = slowParts(bucket * 900_000, tz);
    off = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - bucket * 900_000;
    if (cache.size > 200_000) cache.clear();
    cache.set(bucket, off);
  }
  const d = new Date(ms + off);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    weekday: WEEKDAY_NAMES[d.getUTCDay()],
  };
}

export function tzOffsetMs(ms: number, tz: string): number {
  const p = slowParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in tz -> epoch ms. Handles DST edges. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(guess, tz);
  let res = guess - off1;
  const off2 = tzOffsetMs(res, tz);
  if (off2 !== off1) res = guess - off2;
  return res;
}

export function startOfLocalDay(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return zonedToUtc(p.y, p.mo, p.d, 0, 0, tz);
}

export function addLocalDays(dayStart: number, n: number, tz: string): number {
  const p = localParts(dayStart + 12 * HOUR_MS, tz);
  return zonedToUtc(p.y, p.mo, p.d + n, 0, 0, tz);
}

/**
 * Same wall-clock time `days` days / `months` months away (day clamped to the month's length, so Jan 31 + 1mo = Feb
 * 28). NaN when out of range.
 */
function shiftLocal(ms: number, tz: string, days: number, months: number): number {
  const p = localParts(ms, tz);
  let y = p.y,
    mo = p.mo,
    d = p.d;
  if (months) {
    const idx = mo - 1 + months;
    y += Math.floor(idx / 12);
    mo = (((idx % 12) + 12) % 12) + 1;
    d = Math.min(d, daysIn(y, mo));
  }
  const approxYear = y + days / 365.25;
  if (!(approxYear > 1000 && approxYear < 9000)) return NaN;
  return zonedToUtc(y, mo, d + days, p.h, p.mi, tz) + p.s * 1000 + (ms % 1000);
}

const UNIT = '(min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?|mo|mos|months?|y|yr|yrs|years?)';
const PAST_RE = new RegExp(`^(?:(?:last|past) )?(?:(\\d{1,6}) ?|(an?) )${UNIT}(?: ago)?$`);
const FUTURE_RE = new RegExp(`^(?:(\\d{1,6}) ?|(an?) )${UNIT}$`);
const BARE_M_RE = /^(?:(?:last|past|in) )?\d{1,6} ?m(?: ago| from now| later)?$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:t| (?:at )?)(.+?) ?(z|[+-]\d{2}(?::?\d{2})?)?$/;
const CLOCK_RE = /^(\d{1,2})(?::(\d{2})(?::(\d{2})(\.\d+)?)?)? ?(am|pm|a\.m\.|p\.m\.)?$/;
const PAST_GRACE_MS = 30_000;

export const ACCEPTED =
  '2026-10-01, 2026-10-01 18:00, 2026-10 (month), 2026 (year), 30min, 3h, 3d, 2w, 6mo, 1y, "3 days ago", today, yesterday, this week, last month, this year';

export type TimeKind = 'calendar' | 'relative' | 'instant';
export interface ParsedTime {
  start: number;
  end: number;
  kind: TimeKind;
}
export type FutureField = 'send_at' | 'remind_at';
export interface FutureTime {
  at: number;
  assumed?: string;
}

interface ParseCtx {
  input: string;
  tz: string;
  now: number;
  field?: FutureField;
}
interface Parsed extends ParsedTime {
  form?: 'date' | 'month' | 'clock';
}

const norm = (input: string) =>
  input
    .trim()
    .toLowerCase()
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, ' ');

function tomorrowDate(c: ParseCtx): string {
  const p = localParts(addLocalDays(startOfLocalDay(c.now, c.tz), 1, c.tz) + 12 * HOUR_MS, c.tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

function invalid(c: ParseCtx, message: string): ToolError {
  const forms = c.field
    ? `Use a future time: 30min, 2h, 3d, 2w, 6mo, 1y, "in 2 hours", 9am, today 17:00, tomorrow 09:00 or ${tomorrowDate(c)}T09:00`
    : `Use one of: ${ACCEPTED}`;
  return new ToolError(
    'invalid_time',
    message,
    `${forms}. Times are in ${c.tz}. It is now ${fmtShort(c.now, c.tz, c.now)}.`,
  );
}

function rejectBareM(c: ParseCtx, s: string): void {
  if (BARE_M_RE.test(s))
    throw new ToolError(
      'ambiguous_unit',
      `"${c.input.trim()}" could mean minutes or months.`,
      'Use 30min for minutes or 6mo for months.',
    );
}

/**
 * Rejects user-typed fields that Date.UTC would silently roll over (Feb 30, month 13, 25:00). Never call it on computed
 * bounds.
 */
function checkFields(c: ParseCtx, y: number, mo: number, d = 1, h = 0, mi = 0, s = 0): void {
  let why: string | undefined;
  if (mo < 1 || mo > 12) why = `there is no month ${mo}`;
  else if (d < 1) why = 'days start at 01';
  else if (d > daysIn(y, mo)) why = `${MONTHS[mo - 1]} ${y} has ${daysIn(y, mo)} days`;
  else if (h > 23 || mi > 59 || s > 59) why = 'hours go 00-23, minutes and seconds 00-59';
  if (why) throw invalid(c, `"${c.input.trim()}" is not a real date or time (${why}).`);
}

function parseClock(c: ParseCtx, str: string): { h: number; mi: number; s: number; ms: number } | null {
  if (str === 'noon') return { h: 12, mi: 0, s: 0, ms: 0 };
  const m = str.match(CLOCK_RE);
  if (!m || (m[2] === undefined && !m[5])) return null;
  let h = +m[1];
  if (m[5]) {
    if (h < 1 || h > 12) throw invalid(c, `"${c.input.trim()}" is not a real time (with am/pm, hours go 1-12).`);
    h = (h % 12) + (m[5].startsWith('p') ? 12 : 0);
  }
  return { h, mi: +(m[2] ?? 0), s: +(m[3] ?? 0), ms: m[4] ? Math.round(+m[4] * 1000) : 0 };
}

function offsetMs(c: ParseCtx, str: string): number {
  if (str === 'z') return 0;
  const oh = +str.slice(1, 3),
    om = +(str.slice(3).replace(':', '') || 0);
  if (oh > 14 || om > 59)
    throw invalid(c, `"${c.input.trim()}" has an impossible UTC offset (offsets go -12:00 to +14:00).`);
  return (str[0] === '-' ? -1 : 1) * (oh * 60 + om) * MINUTE_MS;
}

function shift(ms: number, n: number, unit: string, tz: string): number {
  if (unit.startsWith('mi')) return ms + n * MINUTE_MS;
  if (unit.startsWith('h')) return ms + n * HOUR_MS;
  if (unit.startsWith('d')) return shiftLocal(ms, tz, n, 0);
  if (unit.startsWith('w')) return shiftLocal(ms, tz, 7 * n, 0);
  return shiftLocal(ms, tz, 0, unit.startsWith('mo') ? n : 12 * n);
}

function parseCore(c: ParseCtx, s: string): Parsed | null {
  const { tz, now } = c;
  const today = startOfLocalDay(now, tz);
  const days = (from: number, len = 1): Parsed => ({
    start: addLocalDays(today, from, tz),
    end: addLocalDays(today, from + len, tz),
    kind: 'calendar',
  });
  const span = (start: number, end: number): Parsed => ({ start, end, kind: 'calendar' });
  const atClock = (dayOffset: number, t: { h: number; mi: number; s: number; ms: number }): number => {
    const p = localParts(addLocalDays(today, dayOffset, tz) + 12 * HOUR_MS, tz);
    checkFields(c, p.y, p.mo, p.d, t.h, t.mi, t.s);
    return zonedToUtc(p.y, p.mo, p.d, t.h, t.mi, tz) + t.s * 1000 + t.ms;
  };
  if (s === 'now') return { start: now, end: now, kind: 'instant' };
  if (s === 'today') return days(0);
  if (s === 'yesterday') return days(-1);
  if (s === 'tomorrow') return days(1);
  let m = s.match(/^(this|last) (week|month|year)$/);
  if (m) {
    const back = m[1] === 'last' ? 1 : 0;
    const p = localParts(now, tz);
    // ISO weeks start on Monday.
    if (m[2] === 'week') return days(-((WEEKDAY_NAMES.indexOf(p.weekday) + 6) % 7) - 7 * back, 7);
    if (m[2] === 'month')
      return span(zonedToUtc(p.y, p.mo - back, 1, 0, 0, tz), zonedToUtc(p.y, p.mo - back + 1, 1, 0, 0, tz));
    return span(zonedToUtc(p.y - back, 1, 1, 0, 0, tz), zonedToUtc(p.y - back + 1, 1, 1, 0, 0, tz));
  }
  m = s.match(/^this (morning|afternoon|evening)$|^tonight$/);
  if (m) {
    const [from, to] = m[1] === 'morning' ? [0, 12] : m[1] === 'afternoon' ? [12, 18] : [18, 24];
    const p = localParts(today + 12 * HOUR_MS, tz);
    return span(
      zonedToUtc(p.y, p.mo, p.d, from, 0, tz),
      to === 24 ? addLocalDays(today, 1, tz) : zonedToUtc(p.y, p.mo, p.d, to, 0, tz),
    );
  }
  rejectBareM(c, s);
  m = s.match(PAST_RE);
  if (m) return { start: shift(now, -(m[1] ? +m[1] : 1), m[3], tz), end: now, kind: 'relative' };
  m = s.match(/^(\d{4})$/);
  if (m) return span(zonedToUtc(+m[1], 1, 1, 0, 0, tz), zonedToUtc(+m[1] + 1, 1, 1, 0, 0, tz));
  m = s.match(/^([a-z]{3,9})\.? (\d{4})$/);
  if (m) {
    const word = m[1];
    const mo = MONTH_NAMES.findIndex((n) => n.startsWith(word)) + 1;
    if (mo) return span(zonedToUtc(+m[2], mo, 1, 0, 0, tz), zonedToUtc(+m[2], mo + 1, 1, 0, 0, tz));
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    checkFields(c, +m[1], +m[2], +m[3]);
    return {
      ...span(zonedToUtc(+m[1], +m[2], +m[3], 0, 0, tz), zonedToUtc(+m[1], +m[2], +m[3] + 1, 0, 0, tz)),
      form: 'date',
    };
  }
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    checkFields(c, +m[1], +m[2]);
    return { ...span(zonedToUtc(+m[1], +m[2], 1, 0, 0, tz), zonedToUtc(+m[1], +m[2] + 1, 1, 0, 0, tz)), form: 'month' };
  }
  m = s.match(DATETIME_RE);
  if (m) {
    const t = parseClock(c, m[4]);
    if (t) {
      const [y, mo, d] = [+m[1], +m[2], +m[3]];
      checkFields(c, y, mo, d, t.h, t.mi, t.s);
      const at = m[5]
        ? Date.UTC(y, mo - 1, d, t.h, t.mi, t.s, t.ms) - offsetMs(c, m[5])
        : zonedToUtc(y, mo, d, t.h, t.mi, tz) + t.s * 1000 + t.ms;
      return { start: at, end: at, kind: 'instant' };
    }
  }
  m = s.match(/^(today|tomorrow|yesterday) (?:at )?(.+)$/);
  if (m) {
    const t = parseClock(c, m[2]);
    if (t) {
      const at = atClock(m[1] === 'today' ? 0 : m[1] === 'tomorrow' ? 1 : -1, t);
      return { start: at, end: at, kind: 'instant' };
    }
  }
  const t = parseClock(c, s.replace(/^at /, ''));
  if (t) {
    const at = atClock(0, t);
    return { start: at, end: at, kind: 'instant', form: 'clock' };
  }
  return null;
}

/**
 * Parses a time input into an interval [start, end). Relative inputs end at now. 'min' = minutes, 'mo' = months; a bare
 * 'm' is ambiguous_unit.
 */
export function parseTimeInput(input: string, tz: string, now: number): ParsedTime {
  const c: ParseCtx = { input, tz, now };
  const r = parseCore(c, norm(input));
  if (!r) throw invalid(c, `Couldn't read the time "${input.trim()}".`);
  if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) throw invalid(c, `"${input.trim()}" is out of range.`);
  return { start: r.start, end: r.end, kind: r.kind };
}

/**
 * A send_at / remind_at value: relative values count forward, a date alone or bare 'tomorrow' means 09:00 local, and
 * anything not in the future is refused.
 */
export function parseFutureTime(input: string, tz: string, now: number, field: FutureField): FutureTime {
  const c: ParseCtx = { input, tz, now, field };
  const s = norm(input);
  rejectBareM(c, s);
  const m = s
    .replace(/^in /, '')
    .replace(/ (?:from now|later)$/, '')
    .match(FUTURE_RE);
  let at: number;
  let assumed: string | undefined;
  if (m) at = shift(now, m[1] ? +m[1] : 1, m[3], tz);
  else if (/ ago$/.test(s) || /^(?:now|yesterday)$|^(?:yesterday|last|past) /.test(s))
    throw invalid(c, `"${input.trim()}" is not in the future, and ${field} must be.`);
  else if (s === 'today') throw invalid(c, `"${input.trim()}" needs a time of day, e.g. today 17:00.`);
  else {
    const p = parseCore(c, s);
    if (!p) throw invalid(c, `Couldn't read the time "${input.trim()}".`);
    if (p.form === 'date' || s === 'tomorrow') {
      const d = localParts(p.start + 12 * HOUR_MS, tz);
      at = zonedToUtc(d.y, d.mo, d.d, 9, 0, tz);
      assumed = `No time was given, so 09:00 ${tzAbbr(at, tz)} was used.`;
    } else if (p.kind === 'instant')
      at = p.form === 'clock' && p.start <= now + PAST_GRACE_MS ? shiftLocal(p.start, tz, 1, 0) : p.start;
    else throw invalid(c, `"${input.trim()}" is a whole ${p.form ?? 'span'}, not a moment.`);
  }
  if (!Number.isFinite(at)) throw invalid(c, `"${input.trim()}" is out of range.`);
  if (at <= now + PAST_GRACE_MS) {
    throw new ToolError(
      `${field}_in_past`,
      `"${input.trim()}" is ${fmtShort(at, tz, now)}${assumed ? ' (09:00, since no time was given)' : ''}, which has passed.`,
      `It is now ${fmtShort(now, tz, now)}. Pass a future time like 2h, tomorrow 09:00 or ${tomorrowDate(c)}T09:00.`,
    );
  }
  return assumed ? { at, assumed } : { at };
}

export interface TimeRange {
  after?: number;
  before?: number;
}

/**
 * Applies the after / before / on rules: on excludes the others; after must precede before. A relative or datetime `on`
 * means the whole local day containing it.
 */
export function resolveRange(
  args: { after?: string; before?: string; on?: string },
  tz: string,
  now: number,
): TimeRange {
  if (args.on && (args.after || args.before)) {
    throw new ToolError(
      'invalid_time',
      '"on" can\'t be combined with "after" or "before".',
      'Use "on" alone for one day, or "after"/"before" for a range.',
    );
  }
  if (args.on) {
    const i = parseTimeInput(args.on, tz, now);
    if (i.kind === 'calendar') return { after: i.start, before: i.end };
    const day = startOfLocalDay(i.start, tz);
    return { after: day, before: addLocalDays(day, 1, tz) };
  }
  const r: TimeRange = {};
  if (args.after) r.after = parseTimeInput(args.after, tz, now).start;
  if (args.before) r.before = parseTimeInput(args.before, tz, now).start;
  if (r.after !== undefined && r.before !== undefined && r.after >= r.before) {
    throw new ToolError(
      'invalid_time',
      `"after" (${fmtShort(r.after, tz, now)}) is not earlier than "before" (${fmtShort(r.before, tz, now)}).`,
      'Swap them, or widen the range. "before" is exclusive: before 2026-03-30 stops at the end of Mar 29.',
    );
  }
  return r;
}

const shortFmtCache = new Map<string, Intl.DateTimeFormat>();
export function tzAbbr(ms: number, tz: string): string {
  let f = shortFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
    shortFmtCache.set(tz, f);
  }
  return f.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? tz;
}

/** "Thu Oct 16" (adds the year when it isn't the current one). */
export function fmtDay(ms: number, tz: string, now: number): string {
  const p = localParts(ms, tz);
  const year = localParts(now, tz).y === p.y ? '' : ` ${p.y}`;
  return `${p.weekday} ${MONTHS[p.mo - 1]} ${p.d}${year}`;
}

/** "Thu Oct 16 21:04 EDT" (adds the year when it isn't the current one). */
export function fmtShort(ms: number, tz: string, now: number): string {
  const p = localParts(ms, tz);
  return `${fmtDay(ms, tz, now)} ${pad(p.h)}:${pad(p.mi)} ${tzAbbr(ms, tz)}`;
}

/** "Sat Oct 17 2026 16:47 EDT": always with the year. */
export function fmtLong(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.weekday} ${MONTHS[p.mo - 1]} ${p.d} ${p.y} ${pad(p.h)}:${pad(p.mi)} ${tzAbbr(ms, tz)}`;
}

/**
 * "Sun Mar 1 – Tue Mar 31" for whole local days (before is exclusive, so the last day printed is the one before it),
 * "from …" / "before …" when one-sided.
 */
export function fmtRange(r: TimeRange, tz: string, now: number): string {
  const midnight = (ms: number) => startOfLocalDay(ms, tz) === ms;
  const edge = (ms: number) => (midnight(ms) ? fmtDay(ms, tz, now) : fmtShort(ms, tz, now));
  if (r.after !== undefined && r.before !== undefined) {
    if (!midnight(r.after) || !midnight(r.before))
      return `${fmtShort(r.after, tz, now)} – ${fmtShort(r.before, tz, now)}`;
    const last = addLocalDays(r.before, -1, tz);
    return last <= r.after ? fmtDay(r.after, tz, now) : `${fmtDay(r.after, tz, now)} – ${fmtDay(last, tz, now)}`;
  }
  if (r.after !== undefined) return `from ${edge(r.after)}`;
  if (r.before !== undefined) return `before ${edge(r.before)}`;
  return '';
}

/** "in 30 min", "in 1 h 30 min", "in 2 d", "in 6 mo", "in 2.5 y"; "… ago" when past. */
export function fmtDueIn(at: number, now: number): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  if (abs < 30_000) return 'now';
  const mins = Math.max(1, Math.round(abs / MINUTE_MS));
  const days = abs / DAY_MS;
  let body: string;
  if (mins < 60) body = `${mins} min`;
  else if (mins < 24 * 60)
    body = mins < 600 && mins % 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.round(mins / 60)} h`;
  else if (days < 60) body = `${Math.round(days)} d`;
  else if (days < 365) body = `${Math.round(days / 30.44)} mo`;
  else body = `${Math.round((days / 365.25) * 10) / 10} y`;
  return diff > 0 ? `in ${body}` : `${body} ago`;
}

/** ISO 8601 with the zone's offset: "2026-10-16T21:04:00-04:00". */
export function fmtIso(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  const off = Math.round(tzOffsetMs(ms, tz) / MINUTE_MS);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function fmtClock(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
}
