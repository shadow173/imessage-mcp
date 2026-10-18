import { createHash } from 'node:crypto';
import { MINUTE_MS } from '../lib/units.js';

/**
 * Same recipient + text + files in the same clock minute = same key, so a quick retry can't double-send. A retry that
 * crosses into the next minute gets a new key and sends again, and two deliberate identical texts in one minute send
 * once; --key covers both.
 */
export function autoKey(to: string, text: string, files: string[] = []): string {
  return (
    'cli-' +
    createHash('sha256')
      .update([to, text, ...files, String(Math.floor(Date.now() / MINUTE_MS))].join('\n'))
      .digest('hex')
      .slice(0, 24)
  );
}
