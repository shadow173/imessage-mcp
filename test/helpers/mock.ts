import { MockStore, type MockStoreOptions } from '../../src/mock/mockStore.js';

/** The owner's time zone in every test. */
export const TZ = 'America/New_York';

/** The pinned "now" for tool tests: Sat Oct 17 2026 16:47 EDT. The seed is relative to it, so output dates are exact. */
export const PINNED_NOW = Date.parse('2026-10-17T16:47:00-04:00');

/** A seeded mock store whose clock starts at PINNED_NOW (or opts.now) and then runs in real time, so waits still end. */
export const newMockStore = (opts: Partial<MockStoreOptions> = {}) =>
  new MockStore({ timeZone: TZ, autoReply: false, now: PINNED_NOW, ...opts });

/**
 * A seeded mock store on the real clock, for tests that fetch /files or /view through createApp: those links are
 * stamped with the store's time but checked against the real clock, so a pinned store's links would already be expired.
 */
export const liveClockMockStore = (opts: Partial<MockStoreOptions> = {}) =>
  new MockStore({ timeZone: TZ, autoReply: false, ...opts });
