import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../src/lib/errors.js';
import {
  ACCEPTED,
  fmtDay,
  fmtDueIn,
  fmtIso,
  fmtLong,
  fmtRange,
  fmtShort,
  parseFutureTime,
  parseTimeInput,
  resolveRange,
  zonedToUtc,
} from '../src/lib/time.js';

const tz = 'America/New_York';
const now = zonedToUtc(2026, 10, 17, 16, 47, tz); // Sat Oct 17 2026 16:47 EDT
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => zonedToUtc(y, mo, d, h, mi, tz);
const iso = (ms: number) => fmtIso(ms, tz);
const NOW_TEXT = 'It is now Sat Oct 17 16:47 EDT.';

function err(f: () => unknown): ToolError {
  try {
    f();
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  assert.fail('expected a ToolError');
}
const read = (s: string) => parseTimeInput(s, tz, now);
const future = (s: string, field: 'send_at' | 'remind_at' = 'send_at', n = now) => parseFutureTime(s, tz, n, field);

describe('parseTimeInput units', () => {
  it('min is minutes, mo is months, relative inputs end at now', () => {
    assert.deepEqual(read('30min'), { start: now - 30 * 60_000, end: now, kind: 'relative' });
    assert.equal(iso(read('6mo').start), '2026-04-17T16:47:00-04:00');
    assert.equal(iso(read('6 months ago').start), '2026-04-17T16:47:00-04:00');
    assert.equal(iso(read('1y').start), '2025-10-17T16:47:00-04:00');
    assert.equal(iso(read('3 days ago').start), '2026-10-14T16:47:00-04:00');
    assert.equal(iso(read('last 3 days').start), '2026-10-14T16:47:00-04:00');
    assert.equal(read('an hour ago').start, now - 3_600_000);
  });
  it('a bare m is ambiguous_unit with the exact fix', () => {
    for (const s of ['6m', '6 m', '30m ago', 'last 30m']) {
      const e = err(() => read(s));
      assert.equal(e.code, 'ambiguous_unit', s);
      assert.equal(e.fix, 'Use 30min for minutes or 6mo for months.');
      assert.match(e.message, /could mean minutes or months/);
    }
  });
});

describe('parseTimeInput spans', () => {
  const span = (s: string) => {
    const r = read(s);
    assert.equal(r.kind, 'calendar', s);
    return [iso(r.start), iso(r.end)];
  };
  it('this/last week start on Monday', () => {
    assert.deepEqual(span('this week'), ['2026-10-12T00:00:00-04:00', '2026-10-19T00:00:00-04:00']);
    assert.deepEqual(span('last week'), ['2026-10-05T00:00:00-04:00', '2026-10-12T00:00:00-04:00']);
  });
  it('months, years, bare YYYY, month names, tomorrow', () => {
    assert.deepEqual(span('this month'), ['2026-10-01T00:00:00-04:00', '2026-11-01T00:00:00-04:00']);
    assert.deepEqual(span('last month'), ['2026-09-01T00:00:00-04:00', '2026-10-01T00:00:00-04:00']);
    assert.deepEqual(span('this year'), ['2026-01-01T00:00:00-05:00', '2027-01-01T00:00:00-05:00']);
    assert.deepEqual(span('last year'), ['2025-01-01T00:00:00-05:00', '2026-01-01T00:00:00-05:00']);
    assert.deepEqual(span('2026'), span('this year'));
    assert.deepEqual(span('Mar 2026'), ['2026-03-01T00:00:00-05:00', '2026-04-01T00:00:00-04:00']);
    assert.deepEqual(span('March 2026'), span('2026-03'));
    assert.deepEqual(span('tomorrow'), ['2026-10-18T00:00:00-04:00', '2026-10-19T00:00:00-04:00']);
    assert.deepEqual(span('today'), ['2026-10-17T00:00:00-04:00', '2026-10-18T00:00:00-04:00']);
    assert.deepEqual(span('this morning'), ['2026-10-17T00:00:00-04:00', '2026-10-17T12:00:00-04:00']);
    assert.deepEqual(span('tonight'), ['2026-10-17T18:00:00-04:00', '2026-10-18T00:00:00-04:00']);
  });
  it('datetimes take a 1-2 digit hour, am/pm and offsets', () => {
    const t = (s: string) => {
      const r = read(s);
      assert.equal(r.kind, 'instant', s);
      assert.equal(r.start, r.end);
      return iso(r.start);
    };
    assert.equal(t('2026-10-18 9:00'), '2026-10-18T09:00:00-04:00');
    assert.equal(t('2026-10-18 9am'), '2026-10-18T09:00:00-04:00');
    assert.equal(t('2026-10-18 9:30pm'), '2026-10-18T21:30:00-04:00');
    assert.equal(t('2026-10-18 12am'), '2026-10-18T00:00:00-04:00');
    assert.equal(t('2026-10-18 12pm'), '2026-10-18T12:00:00-04:00');
    assert.equal(t('2026-10-18T9:00-04:00'), '2026-10-18T09:00:00-04:00');
    assert.equal(t('2026-10-18T13:00Z'), '2026-10-18T09:00:00-04:00');
    assert.equal(read('2026-10-18T13:00:00.250Z').start, Date.UTC(2026, 9, 18, 13, 0, 0, 250));
    assert.equal(read('2026-10-18T13:00:00.123456Z').start, read('2026-10-18T13:00:00.123Z').start);
    assert.equal(t('2026-10-18T09:00:30'), '2026-10-18T09:00:30-04:00');
    assert.equal(t('today 9am'), '2026-10-17T09:00:00-04:00');
    assert.equal(t('yesterday 18:30'), '2026-10-16T18:30:00-04:00');
    assert.equal(t('now'), iso(now));
  });
  it('invalid_time lists the accepted forms and the current time', () => {
    const e = err(() => read('next blue moon'));
    assert.equal(e.code, 'invalid_time');
    assert.ok(e.fix!.includes(ACCEPTED));
    assert.ok(e.fix!.endsWith(NOW_TEXT), e.fix);
    assert.match(e.fix!, /America\/New_York/);
    assert.doesNotMatch(ACCEPTED, /6m\b(?!o)|\(months\)/);
    assert.equal(err(() => read('2026-10-18 9')).code, 'invalid_time');
    assert.equal(err(() => read('999999 years ago')).code, 'invalid_time');
  });
});

describe('impossible dates are rejected, not rolled over', () => {
  const cases: [string, RegExp][] = [
    ['2026-13-45', /no month 13/],
    ['2026-00', /no month 0/],
    ['2026-02-29', /Feb 2026 has 28 days/],
    ['2026-02-30', /Feb 2026 has 28 days/],
    ['2026-10-32T10:00', /Oct 2026 has 31 days/],
    ['2026-10-01T25:00', /hours go 00-23/],
    ['2026-10-20T09:60', /minutes and seconds 00-59/],
    ['2026-10-20T09:00:99', /minutes and seconds 00-59/],
    ['2026-10-20T24:00', /hours go 00-23/],
    ['2026-02-30T10:00:00-04:00', /Feb 2026 has 28 days/],
    ['2026-10-18T09:00+15:00', /offset/],
    ['13pm', /hours go 1-12/],
  ];
  for (const [s, why] of cases) {
    it(s, () => {
      const e = err(() => read(s));
      assert.equal(e.code, 'invalid_time');
      assert.match(e.message, why);
      assert.ok(e.fix!.endsWith(NOW_TEXT));
    });
  }
  it('real edge dates still parse', () => {
    assert.equal(iso(read('2028-02-29').start), '2028-02-29T00:00:00-05:00');
    assert.equal(iso(read('2026-12-31T23:59').start), '2026-12-31T23:59:00-05:00');
    assert.equal(iso(read('2026-12').end), '2027-01-01T00:00:00-05:00');
  });
});

describe('resolveRange on', () => {
  const r = (a: { after?: string; before?: string; on?: string }) => {
    const x = resolveRange(a, tz, now);
    return [x.after === undefined ? null : iso(x.after), x.before === undefined ? null : iso(x.before)];
  };
  const oct14 = ['2026-10-14T00:00:00-04:00', '2026-10-15T00:00:00-04:00'];
  it('a relative or datetime on means the whole local day containing it', () => {
    assert.deepEqual(r({ on: '3 days ago' }), oct14);
    assert.deepEqual(r({ on: '3d' }), oct14);
    assert.deepEqual(r({ on: '2026-10-14T10:00' }), oct14);
    assert.deepEqual(r({ on: '2026-10-14T21:00:00-04:00' }), oct14);
    assert.deepEqual(r({ on: 'now' }), ['2026-10-17T00:00:00-04:00', '2026-10-18T00:00:00-04:00']);
  });
  it('a calendar on keeps its span', () => {
    assert.deepEqual(r({ on: '2026-03' }), ['2026-03-01T00:00:00-05:00', '2026-04-01T00:00:00-04:00']);
    assert.deepEqual(r({ on: '2026-10-14' }), oct14);
    assert.deepEqual(r({ on: 'this week' }), ['2026-10-12T00:00:00-04:00', '2026-10-19T00:00:00-04:00']);
  });
  it('after/before use the start, before is exclusive, conflicts explain themselves', () => {
    assert.deepEqual(r({ after: 'last month', before: 'this month' }), [
      '2026-09-01T00:00:00-04:00',
      '2026-10-01T00:00:00-04:00',
    ]);
    assert.deepEqual(r({ before: 'tomorrow' }), [null, '2026-10-18T00:00:00-04:00']);
    assert.equal(err(() => r({ on: 'yesterday', after: '3d' })).code, 'invalid_time');
    const e = err(() => r({ after: '2026-03-30', before: '2026-03-30' }));
    assert.match(e.message, /Mon Mar 30 00:00 EDT/);
    assert.match(e.fix!, /exclusive/);
  });
});

describe('parseFutureTime', () => {
  const f = (s: string, n = now) => iso(future(s, 'send_at', n).at);
  it('relative values count forward, including mo and y', () => {
    assert.equal(future('30min').at, now + 30 * 60_000);
    assert.equal(future('in 2 hours').at, now + 2 * 3_600_000);
    assert.equal(future('2 hours from now').at, now + 2 * 3_600_000);
    assert.equal(f('3d'), '2026-10-20T16:47:00-04:00');
    assert.equal(f('a week'), '2026-10-24T16:47:00-04:00');
    assert.equal(f('6mo'), '2027-04-17T16:47:00-04:00');
    assert.equal(f('1y'), '2027-10-17T16:47:00-04:00');
    assert.equal(future('2h').assumed, undefined);
  });
  it('days keep the wall clock across DST and months clamp to the month length', () => {
    assert.equal(f('1d', at(2026, 10, 31, 16, 47)), '2026-11-01T16:47:00-05:00');
    assert.equal(f('1mo', at(2027, 1, 31, 10, 0)), '2027-02-28T10:00:00-05:00');
    assert.equal(f('1y', at(2028, 2, 29, 10, 0)), '2029-02-28T10:00:00-05:00');
  });
  it('a bare m is ambiguous', () => {
    for (const s of ['30m', 'in 30m', '30 m from now']) {
      const e = err(() => future(s));
      assert.equal(e.code, 'ambiguous_unit');
      assert.equal(e.fix, 'Use 30min for minutes or 6mo for months.');
    }
  });
  it('past forms are invalid_time with only future examples', () => {
    for (const s of [
      '3 days ago',
      'yesterday',
      'yesterday 9am',
      'now',
      'last week',
      'past 3 days',
      'today',
      '2026-10',
      'this week',
      '2026',
      'next blue moon',
    ]) {
      const e = err(() => future(s, 'remind_at'));
      assert.equal(e.code, 'invalid_time', s);
      assert.ok(e.fix!.endsWith(NOW_TEXT), e.fix);
      assert.doesNotMatch(e.fix!, /yesterday|ago/);
      assert.match(e.fix!, /2026-10-18T09:00/);
    }
    assert.match(err(() => future('today')).message, /today 17:00/);
  });
  it('a date alone or bare tomorrow means 09:00 local and says so', () => {
    assert.deepEqual(future('2026-10-18'), {
      at: at(2026, 10, 18, 9),
      assumed: 'No time was given, so 09:00 EDT was used.',
    });
    assert.deepEqual(future('tomorrow'), {
      at: at(2026, 10, 18, 9),
      assumed: 'No time was given, so 09:00 EDT was used.',
    });
    assert.deepEqual(future('2026-11-02'), {
      at: at(2026, 11, 2, 9),
      assumed: 'No time was given, so 09:00 EST was used.',
    });
  });
  it('absolute forms', () => {
    assert.deepEqual(future('tomorrow 9am'), { at: at(2026, 10, 18, 9) });
    assert.equal(f('tomorrow at 09:30'), '2026-10-18T09:30:00-04:00');
    assert.equal(f('today 17:00'), '2026-10-17T17:00:00-04:00');
    assert.equal(f('21:00'), '2026-10-17T21:00:00-04:00');
    assert.equal(f('9am'), '2026-10-18T09:00:00-04:00');
    assert.equal(f('2026-10-18T09:00'), '2026-10-18T09:00:00-04:00');
    assert.equal(f('2026-10-18 9:00'), '2026-10-18T09:00:00-04:00');
    assert.equal(f('2026-10-18T13:00Z'), '2026-10-18T09:00:00-04:00');
  });
  it('anything not in the future is <field>_in_past with the current time', () => {
    const e = err(() => future('2026-10-01T09:00'));
    assert.equal(e.code, 'send_at_in_past');
    assert.equal(e.message, '"2026-10-01T09:00" is Thu Oct 1 09:00 EDT, which has passed.');
    assert.equal(
      e.fix,
      'It is now Sat Oct 17 16:47 EDT. Pass a future time like 2h, tomorrow 09:00 or 2026-10-18T09:00.',
    );
    assert.equal(err(() => future('today 9am', 'remind_at')).code, 'remind_at_in_past');
    assert.equal(err(() => future('0min', 'remind_at')).code, 'remind_at_in_past');
    assert.match(err(() => future('2026-10-17')).message, /since no time was given/);
    assert.match(err(() => future('2020-01-01T09:00')).message, /Wed Jan 1 2020 09:00 EST/);
  });
  it('impossible and out-of-range values are invalid_time', () => {
    assert.match(err(() => future('2027-02-29T09:00')).message, /Feb 2027 has 28 days/);
    assert.equal(err(() => future('2026-11-31T09:00', 'remind_at')).code, 'invalid_time');
    assert.equal(err(() => future('999999y')).code, 'invalid_time');
  });
});

describe('formatters', () => {
  it('fmtLong always has the year; fmtDay is fmtShort without the clock', () => {
    assert.equal(fmtLong(now, tz), 'Sat Oct 17 2026 16:47 EDT');
    assert.equal(fmtShort(now, tz, now), 'Sat Oct 17 16:47 EDT');
    assert.equal(fmtDay(now, tz, now), 'Sat Oct 17');
    assert.equal(fmtDay(at(2025, 8, 24, 16, 22), tz, now), 'Sun Aug 24 2025');
    assert.equal(fmtShort(at(2025, 8, 24, 16, 22), tz, now), 'Sun Aug 24 2025 16:22 EDT');
  });
  it('fmtRange prints whole days inclusively and one-sided ranges plainly', () => {
    const range = (a: { after?: string; before?: string; on?: string }) => fmtRange(resolveRange(a, tz, now), tz, now);
    assert.equal(range({ on: '2026-03' }), 'Sun Mar 1 – Tue Mar 31');
    assert.equal(range({ after: '2026-03-01', before: '2026-03-31' }), 'Sun Mar 1 – Mon Mar 30');
    assert.equal(range({ on: '3 days ago' }), 'Wed Oct 14');
    assert.equal(range({ before: '2025-08-01' }), 'before Fri Aug 1 2025');
    assert.equal(range({ after: '2026-03-01' }), 'from Sun Mar 1');
    assert.equal(range({ after: '3d' }), 'from Wed Oct 14 16:47 EDT');
    assert.equal(
      range({ after: '2026-10-14T10:00', before: '2026-10-15' }),
      'Wed Oct 14 10:00 EDT – Thu Oct 15 00:00 EDT',
    );
    assert.equal(fmtRange({}, tz, now), '');
  });
  it('fmtDueIn', () => {
    assert.equal(fmtDueIn(now + 30 * 60_000, now), 'in 30 min');
    assert.equal(fmtDueIn(now + 90 * 60_000, now), 'in 1 h 30 min');
    assert.equal(fmtDueIn(now + 3 * 3_600_000, now), 'in 3 h');
    assert.equal(fmtDueIn(now + 2 * 86_400_000, now), 'in 2 d');
    assert.equal(fmtDueIn(future('6mo').at, now), 'in 6 mo');
    assert.equal(fmtDueIn(future('1y').at, now), 'in 1 y');
    assert.equal(fmtDueIn(future('30mo').at, now), 'in 2.5 y');
    assert.equal(fmtDueIn(now - 30 * 60_000, now), '30 min ago');
    assert.equal(fmtDueIn(now + 10_000, now), 'now');
  });
});
