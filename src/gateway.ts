import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ALL_SCOPES } from './auth/scopes.js';
import { loadConfig, loadOrExit } from './config.js';
import { serverInstructions } from './mcp/instructions.js';
import { listTools } from './mcpHandler.js';
import { MockStore } from './mock/mockStore.js';
import { RelayHub } from './relay/hub.js';
import { attachBridgeUpgrade } from './relay/upgrade.js';
import { startDraftScheduler } from './services/draftScheduler.js';

const cfg = loadOrExit(() => loadConfig());
let hub: RelayHub | undefined;
let mock: MockStore | undefined;
if (cfg.mode === 'relay') {
  // Tool list served only until the Mac's first hello after this process starts. It follows the gateway's TIERS, which
  // must match the bridge's (bridge default read,send,org,gpt; plus pa with PRIVATE_API=imsg); the hub warns on a
  // mismatch. Listing needs no store, so relay mode runs no mock data at all.
  let cached: unknown;
  hub = new RelayHub(
    async () => (cached ??= await listTools(cfg.tools)),
    cfg.tools.timeZone,
    serverInstructions(cfg.tools.redactCodes),
  );
} else
  mock = new MockStore({
    timeZone: cfg.tools.timeZone,
    autoReply: cfg.tools.autoReply,
    redactCodes: cfg.tools.redactCodes,
  });
const { app, sendLog } = createApp(cfg, hub ? { hub } : { store: mock });
// Mock mode runs the tools here, so scheduled drafts fire here too, counted in the same hourly limit.
if (mock)
  startDraftScheduler({
    store: mock,
    cfg: cfg.tools,
    baseUrl: cfg.publicUrl ?? '',
    sendLog,
    scopes: new Set(ALL_SCOPES),
    resourceMetadataUrl: '',
  });

const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
  console.log(`imessage-mcp gateway (${cfg.mode}) listening on ${cfg.host}:${info.port}`);
  console.log(`MCP endpoint: ${cfg.publicUrl ?? `http://localhost:${info.port}`}/mcp`);
  console.log(`Tiers: ${[...cfg.tools.tiers].join(', ')}`);
});

if (hub && cfg.bridgeSecret) attachBridgeUpgrade(server, hub, cfg.bridgeSecret);
