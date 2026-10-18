// Checks preview and text extraction on the newest PDF and photo in YOUR REAL chat.db (needs Full Disk Access).
// Sends nothing; prints sizes and timings only. Uses its own sidecar (DATA_DIR, default imessage-mcp-probe), never the
// running bridge's.
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
for (const kind of ['pdf', 'image'] as const) {
  const att = store.listAttachments({ kinds: [kind] }, { limit: 1, offset: 0 }).items[0];
  if (!att) {
    console.log(kind, 'none');
    continue;
  }
  let s = Date.now();
  const prev = await store.attachmentPreview(att.attachmentId, 1200);
  console.log(
    `${kind} preview: ${prev ? `${prev.mime}, ${Math.round((prev.base64.length * 0.75) / 1024)} KB` : 'none'} in ${Date.now() - s} ms`,
  );
  s = Date.now();
  const text = await store.attachmentText(att.attachmentId);
  console.log(`${kind} text: ${text ? `${text.length} chars` : 'none'} in ${Date.now() - s} ms`);
}
process.exit(0);
