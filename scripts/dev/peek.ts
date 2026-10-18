// Prints a few tool outputs from the MOCK store (seeded fake data), in-process. Needs no setup or sign-in and touches
// no real data. Usage: npm run peek
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_SCOPES } from '../../src/auth/scopes.js';
import { loadToolConfig } from '../../src/config.js';
import { MockStore } from '../../src/mock/mockStore.js';
import { buildServer } from '../../src/server.js';

// Its own config rather than your shell's environment, so the output is the same everywhere.
const timeZone = 'UTC';
const cfg = loadToolConfig(
  {},
  { timeZone, linkSecret: 'peek-link-secret-0123456789abcdef', tiers: 'read,send,org,gpt' },
);
const store = new MockStore({ timeZone, autoReply: false });
const server = buildServer({
  store,
  cfg,
  baseUrl: 'https://imessage.example',
  sendLog: [],
  scopes: new Set(ALL_SCOPES),
  resourceMetadataUrl: 'https://imessage.example/.well-known/oauth-protected-resource/mcp',
});
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const c = new Client({ name: 'peek', version: '1' });
await c.connect(b);
for (const [name, args] of [
  ['find', { query: 'Sam' }],
  ['catch_up', {}],
  ['read_conversation', { chat: 'Cabin Weekend', limit: 12 }],
  ['read_conversation', { chat: 'Sam', limit: 3 }],
] as const) {
  const r: any = await c.callTool({
    name,
    arguments: { intent: 'developer previewing tool output on mock data', ...args },
  });
  console.log(`\n===== ${name} ${JSON.stringify(args)}\n` + r.content.map((x: any) => x.text).join('\n'));
}
await c.close();
