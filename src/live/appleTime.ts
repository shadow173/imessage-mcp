/**
 * Apple's reference date, 2001-01-01T00:00:00Z, in Unix milliseconds. chat.db stores message dates as nanoseconds
 * after it (seconds on very old rows), and binary plists store dates as seconds after it.
 */
export const APPLE_EPOCH_MS = 978_307_200_000;

/**
 * Unix ms to chat.db nanoseconds, for comparing against message.date in SQL.
 * @example toAppleNs(Date.parse('2001-01-01T00:00:01Z')) // 1000000000n
 */
export const toAppleNs = (ms: number) => BigInt(Math.floor(ms) - APPLE_EPOCH_MS) * 1_000_000n;

/**
 * chat.db nanoseconds to Unix ms.
 * @example fromAppleNs(1000000000n) // Date.parse('2001-01-01T00:00:01Z')
 */
export const fromAppleNs = (ns: number | bigint) => Number(BigInt(ns) / 1_000_000n) + APPLE_EPOCH_MS;
