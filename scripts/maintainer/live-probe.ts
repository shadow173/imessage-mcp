// Exercises every read tool against YOUR REAL chat.db (needs Full Disk Access). Sends nothing. Prints timings, sizes
// and counts only: no message text, no names. Uses its own sidecar (DATA_DIR, default imessage-mcp-probe), never the
// running bridge's.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_SCOPES } from '../../src/auth/scopes.js';
import { loadBridgeConfig } from '../../src/config.js';
import { LiveStore } from '../../src/live/liveStore.js';
import { buildServer } from '../../src/server.js';

const cfg = loadBridgeConfig({
  ...process.env,
  DATA_DIR: process.env.DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'imessage-mcp-probe'),
});
const t0 = Date.now();
const store = new LiveStore(cfg);
console.log(`store opened in ${Date.now() - t0} ms · people ${store.people().length} · chats ${store.chats().length}`);
store.start();

async function connect() {
  const server = buildServer({
    store,
    cfg: cfg.tools,
    baseUrl: 'https://example.invalid',
    sendLog: [],
    scopes: new Set(ALL_SCOPES),
    resourceMetadataUrl: 'https://example.invalid/x',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'probe', version: '1' });
  await c.connect(b);
  return c;
}
const c = await connect();
const call = async (name: string, args: Record<string, unknown>) => {
  const s = Date.now();
  const r: any = await c.callTool({
    name,
    arguments: { intent: 'owner checking tool timings on the real chat.db', ...args },
  });
  const text = r.content?.map((x: any) => x.text ?? '').join('\n') ?? '';
  const code = r.isError ? (text.match(/^Error (\w+)/)?.[1] ?? 'error') : 'ok';
  console.log(
    `${name.padEnd(20)} ${String(Date.now() - s).padStart(5)} ms  ${code.padEnd(16)} ${String(text.length).padStart(7)} chars  ${text.split('\n').length} lines`,
  );
  return r;
};

await call('get_status', {});
await call('list_conversations', { limit: 20, format: 'json' });
await call('list_conversations', { needs_reply: true, limit: 20 });
await call('list_conversations', { type: 'group', limit: 20 });
await call('catch_up', {});
const sums = store.chatSummaries().sort((a, b) => b.messageCount - a.messageCount);
const big = sums[0];
console.log(`largest chat: ${big.messageCount} messages, type ${big.chat.type}`);
// Page the largest chat back to its first message.
let s = Date.now(),
  seen = 0,
  pages = 0,
  dup = 0,
  cursor: string | undefined,
  total = 0;
const ids = new Set<string>();
let withReactions = 0,
  withText = 0,
  unknownSender = 0;
while (true) {
  const r: any = await c.callTool({
    name: 'read_conversation',
    arguments: {
      chat: big.chat.chatId,
      limit: 200,
      format: 'json',
      intent: 'owner checking paging on the largest chat',
      ...(cursor ? { cursor } : {}),
    },
  });
  if (r.isError) {
    console.log('read error', r.content[0].text.split('\n')[0]);
    break;
  }
  const sc = r.structuredContent;
  total = sc.total_in_range;
  pages++;
  for (const m of sc.messages) {
    if (ids.has(m.message_id)) dup++;
    ids.add(m.message_id);
    if (m.reactions.length) withReactions++;
    if (m.text) withText++;
    if (m.from !== 'me' && m.from.name === 'Unknown') unknownSender++;
  }
  seen += sc.messages.length;
  cursor = sc.older_cursor ?? undefined;
  if (!cursor) break;
}
console.log(
  `paged largest chat: ${pages} pages, ${seen}/${total} messages, ${dup} duplicates, ${Date.now() - s} ms total · with text ${withText} · with reactions ${withReactions} · unknown senders ${unknownSender}`,
);
const firstId = [...ids][Math.floor(ids.size / 2)];
await call('get_conversation', { chat: big.chat.chatId });
await call('get_message', { message_id: firstId, context_before: 5, context_after: 5 });
const pid = big.chat.participantIds[0];
if (pid) await call('get_person', { person: pid });
await call('get_stats', { group_by: 'person', top: 10 });
await call('get_stats', { group_by: 'month' });
const la = await call('list_attachments', { limit: 10, format: 'json' });
const att = la.structuredContent?.attachments?.[0];
if (att) await call('get_attachment', { attachment_id: att.attachment_id, mode: 'metadata' });
await call('list_links', { limit: 10 });
const thread = (
  store.chatDb
    .prepare('select ROWID r from message where thread_originator_guid is not null order by ROWID desc limit 1')
    .get() as any
)?.r;
if (thread) await call('get_reply_thread', { message_id: `m${thread}` });
await call('search_messages', { query: 'the' });
// Wait for the search index, then search again.
s = Date.now();
while (!store.indexStatus().ready) await new Promise((r) => setTimeout(r, 500));
console.log(`search index built in ${Date.now() - s} ms after start`);
await call('search_messages', { query: 'thanks', limit: 20 });
await call('search_messages', { query: 'thanks', from: 'me', after: '6mo', context: 2 });
await call('find', { query: 'dinner' });
await call('search', { query: 'dinner' });
await call('get_updates', { cursor: 'now' });
store.stop();
process.exit(0);
