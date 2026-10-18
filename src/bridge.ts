// The Mac bridge: runs the tools against chat.db and serves them to the gateway over a WebSocket it opens itself.
// Without GATEWAY_URL it runs local only: the CLI and `imessage mcp` reach it through the Unix socket.

import { ALL_SCOPES } from './auth/scopes.js';
import { createFrameHandler } from './bridge/frames.js';
import { connectGateway } from './bridge/gatewayClient.js';
import { checkSocketPath, loadBridgeConfig, loadEnvFile, loadOrExit } from './config.js';
import { Journal } from './lib/journal.js';
import { VERSION } from './lib/version.js';
import { ImsgRpc } from './live/imsgRpc.js';
import { LiveStore } from './live/liveStore.js';
import { resolveExecutable } from './live/macos.js';
import { createSender } from './live/sender.js';
import { startLocalServer } from './local/socketServer.js';
import { serverInstructions } from './mcp/instructions.js';
import { listTools } from './mcpHandler.js';
import { startDraftScheduler, stopDraftScheduler } from './services/draftScheduler.js';
import type { Ctx } from './tools/context.js';

// Crash loudly rather than limp on: launchd restarts the bridge, and the reason lands in bridge.log.
process.on('unhandledRejection', (e) => {
  console.error('unhandled rejection:', e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('uncaught exception:', e);
  process.exit(1);
});

// Variables already set win over the file.
const env: NodeJS.ProcessEnv = { ...loadEnvFile(process.env), ...process.env };
const cfg = loadOrExit(() => {
  const c = loadBridgeConfig(env);
  checkSocketPath(c.socketPath);
  return c;
});
/** Origin for links the tools mint; empty when local only, so no link points at a gateway that doesn't exist. */
const baseUrl = cfg.gatewayUrl ?? '';

let imsg: ImsgRpc | undefined;
if (cfg.privateApi === 'imsg') {
  // Resolved once, so a different imsg earlier on PATH later can't take over.
  const bin = resolveExecutable(cfg.imsgPath, env.PATH);
  console.log(`private API (imsg): ${bin ?? `"${cfg.imsgPath}" not found on PATH`}`);
  const imsgEnv = Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[0].startsWith('IMSG_') && e[0] !== 'IMSG_PATH' && e[1] !== undefined,
    ),
  );
  // Nothing starts until the first call.
  imsg = new ImsgRpc(bin ?? cfg.imsgPath, { autoLaunch: cfg.imsgAutoLaunch, env: imsgEnv });
}
const store = new LiveStore(cfg, { sender: (deps) => createSender(deps, cfg), privateApi: imsg });
store.start();
store.warmExtractor();
void store.checkAutomation().then(() => console.log(`Messages automation: ${store.automation}`));
if (imsg)
  void store
    .privateApiStatus()
    .then((s) =>
      console.log(
        `private API (imsg): ${s.bridgeReady ? `ready · ${s.methods.length} methods` : `not ready (${(s.reason ?? 'unknown').split('\n')[0]})`}`,
      ),
    )
    .catch((e) => console.error('private API status check failed:', (e as Error).message));
const sendLog: number[] = [];
// Every tool call with its intent, in the sidecar on this Mac. Read with `imessage journal`.
const journal = new Journal(store.side.db);
const ctxFor = (scopes: string[], baseUrl: string, client = 'unknown'): Ctx => ({
  store,
  cfg: cfg.tools,
  baseUrl,
  sendLog,
  scopes: new Set(scopes),
  resourceMetadataUrl: `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
  client,
  journal: journal.sink,
});
// Scheduled drafts fire from here (through the same policy as send_now), sharing the bridge's rate-limit log.
startDraftScheduler(ctxFor(ALL_SCOPES, baseUrl));
if (env.LOCAL_SOCKET?.trim() && !env.IMESSAGE_SOCKET?.trim())
  console.warn('LOCAL_SOCKET is deprecated: rename it to IMESSAGE_SOCKET.');
const localServer = startLocalServer(
  cfg.socketPath,
  store,
  (scopes, client) => ctxFor(scopes, baseUrl, client),
  journal,
);
console.log(`local socket: ${cfg.socketPath}`);
console.log(
  [
    `bridge v${VERSION}`,
    `${store.people().length} people`,
    `${store.chats().length} chats`,
    `tiers ${[...cfg.tools.tiers].join(',')}`,
    `send ${cfg.tools.sendEnabled ? 'on' : 'off'}`,
    `tz ${cfg.tools.timeZone}`,
    ...(cfg.hide.length ? [`${cfg.hide.length} hidden`] : []),
  ].join(' · '),
);

const gateway = cfg.gatewayUrl
  ? connectGateway({
      url: cfg.gatewayUrl,
      secret: cfg.bridgeSecret ?? '',
      hello: async () => ({
        type: 'hello',
        version: VERSION,
        mode: 'live',
        toolsList: await listTools(cfg.tools),
        me: store.me().name,
        tiers: [...cfg.tools.tiers],
        instructions: serverInstructions(cfg.tools.redactCodes),
      }),
      handle: createFrameHandler(store, ctxFor),
      onReplaced: () => {
        // Another bridge connected and the gateway kept that one. Reconnecting would make the two fight forever.
        console.error('another bridge took over this connection; exiting. Run only one bridge (the LaunchAgent).');
        store.stop();
        process.exit(3);
      },
    })
  : undefined;
if (!gateway) console.log('local only (no gateway): GATEWAY_URL is not set');
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    console.log('stopping');
    stopDraftScheduler(store);
    store.stop();
    imsg?.stop();
    localServer.close();
    gateway?.close();
    setTimeout(() => process.exit(0), 300);
  });
