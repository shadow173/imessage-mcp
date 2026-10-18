// Times LiveStore queries against YOUR REAL chat.db (needs Full Disk Access). Sends nothing; prints timings and
// counts only. Uses its own sidecar (DATA_DIR, default imessage-mcp-probe), never the running bridge's.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadBridgeConfig } from '../../src/config.js';
import { LiveStore } from '../../src/live/liveStore.js';

const store = new LiveStore(
  loadBridgeConfig({
    ...process.env,
    DATA_DIR: process.env.DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'imessage-mcp-probe'),
  }),
);
const t = (label: string, fn: () => unknown) => {
  const s = performance.now();
  const r: any = fn();
  console.log(
    label.padEnd(28),
    (performance.now() - s).toFixed(0).padStart(5),
    'ms',
    Array.isArray(r) ? `${r.length} items` : r?.items ? `${r.items.length}/${r.total}` : '',
  );
};
t('chatSummaries (cold)', () => store.chatSummaries());
t('chatSummaries (cached)', () => store.chatSummaries());
t('counts', () => store.counts());
t('listAttachments', () => store.listAttachments({}, { limit: 10, offset: 0 }));
t('listAttachments again', () => store.listAttachments({}, { limit: 10, offset: 10 }));
t('listMessages links', () => store.listMessages({ hasLink: true }, { order: 'desc', limit: 10, offset: 0 }));
process.exit(0);
