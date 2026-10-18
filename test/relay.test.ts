import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { type ServerType, serve } from '@hono/node-server';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { pkceS256, randomId } from '../src/auth/crypto.js';
import { ALL_SCOPES } from '../src/auth/scopes.js';
import { VERSION } from '../src/lib/version.js';
import { SERVER_INSTRUCTIONS, serverInstructions } from '../src/mcp/instructions.js';
import { handleMcp } from '../src/mcpHandler.js';
import { RelayHub } from '../src/relay/hub.js';
import { CLOSE_REPLACED_BY_NEWER, type GatewayToBridge, MAX_FRAME_BYTES } from '../src/relay/protocol.js';
import { attachBridgeUpgrade } from '../src/relay/upgrade.js';
import { captureConsole } from './helpers/console.js';
import { toolConfig } from './helpers/ctx.js';
import { devGatewayConfig } from './helpers/gateway.js';
import { newMockStore } from './helpers/mock.js';
import { waitFor } from './helpers/wait.js';

const PASSWORD = 'relay test password';
const SECRET = 'b'.repeat(40);
let server: ServerType;
let base: string;
let hub: RelayHub;
let token: string;
let bridge: WebSocket | null = null;
let lastGrant: string[] = [];

/** Opens a socket to the gateway's bridge endpoint; rejects with "HTTP <status>" when the upgrade is refused. */
async function openSocket(authorization: string, path = '/bridge', url = base): Promise<WebSocket> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}${path}`, { headers: { Authorization: authorization } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_q, r) => reject(new Error(`HTTP ${r.statusCode}`)));
    ws.once('error', reject);
  });
  return ws;
}
const closeCode = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

async function connectBridge(secret = SECRET, path = '/bridge'): Promise<WebSocket> {
  const store = newMockStore();
  const cfg = toolConfig();
  const ws = await openSocket(`Bearer ${secret}`, path);
  ws.on('message', async (data) => {
    const f = JSON.parse(String(data)) as GatewayToBridge;
    if (f.type !== 'mcp') return;
    lastGrant = f.grant.scopes;
    const r = await handleMcp(
      { store, cfg, baseUrl: f.baseUrl, sendLog: [], scopes: new Set(f.grant.scopes), resourceMetadataUrl: '' },
      f.body,
    );
    ws.send(JSON.stringify({ type: 'mcp_result', id: f.id, ...r }));
  });
  const prev = hub.hello;
  ws.send(
    JSON.stringify({
      type: 'hello',
      version: 'test',
      mode: 'mock',
      toolsList: { tools: [{ name: 'from_hello', inputSchema: { type: 'object' } }] },
      me: 'x',
    }),
  );
  await waitFor(() => hub.hello !== prev && hub.connected(), 'the hub to receive hello');
  return ws;
}

async function rpc(method: string, params: Record<string, unknown> = {}, auth = true) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
}

before(async () => {
  const cfg = devGatewayConfig(PASSWORD, { MODE: 'relay', BRIDGE_SECRET: SECRET });
  hub = new RelayHub(
    async () => ({ tools: [{ name: 'fallback_tool', inputSchema: { type: 'object' } }] }),
    'America/New_York',
  );
  const { app } = createApp(cfg, { hub });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The gateway's own upgrade handler, so these tests check what production runs.
  const wss = attachBridgeUpgrade(server, hub, SECRET);
  assert.equal(wss.options.maxPayload, MAX_FRAME_BYTES);
  // OAuth once, read-only, to check that the grant reaches the bridge.
  const reg = await (
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'] }),
    })
  ).json();
  const verifier = randomId(32);
  const u = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: 'http://127.0.0.1/callback',
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    scope: ALL_SCOPES.join(' '),
  }))
    u.searchParams.set(k, v);
  const req = (await (await fetch(u)).text()).match(/name="req" value="([^"]+)"/)![1];
  const loc = new URL(
    (
      await fetch(`${base}/authorize`, {
        method: 'POST',
        body: new URLSearchParams({ req, password: PASSWORD, action: 'allow' }),
        redirect: 'manual',
      })
    ).headers.get('location')!,
  );
  token = (
    await (
      await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: loc.searchParams.get('code')!,
          client_id: reg.client_id,
          code_verifier: verifier,
          redirect_uri: 'http://127.0.0.1/callback',
        }),
      })
    ).json()
  ).access_token;
});
after(() => {
  bridge?.close();
  server.close();
});

describe('relay', () => {
  it('rejects a bridge with the wrong secret, without the Bearer prefix, or on another path', async () => {
    await assert.rejects(connectBridge('wrong'.repeat(8)), /401/);
    await assert.rejects(openSocket(SECRET), /401/);
    await assert.rejects(openSocket(`bearer ${SECRET}`), /401/);
    await assert.rejects(openSocket(`Bearer ${SECRET}`, '/bridges'), /401/);
    await assert.rejects(openSocket(`Bearer ${SECRET}`, '/mcp'), /401/);
  });

  it('answers while the Mac has never connected: initialize, fallback tools, mac_offline', async () => {
    assert.deepEqual(
      (
        await rpc('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        })
      ).json.result.serverInfo,
      { name: 'imessage', version: VERSION },
    );
    assert.equal((await rpc('tools/list')).json.result.tools[0].name, 'fallback_tool');
    const call = await rpc('tools/call', {
      name: 'find',
      arguments: { query: 'x', intent: 'relay test of a forwarded call' },
    });
    assert.equal(call.json.result.isError, true);
    assert.match(call.json.result.content[0].text, /mac_offline/);
    assert.equal((await rpc('tools/list', {}, false)).status, 401);
  });

  it("forwards calls to the connected bridge with the caller's scopes", async () => {
    bridge = await connectBridge();
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
    const r = await rpc('tools/call', { name: 'get_status', arguments: { intent: 'relay test of a forwarded call' } });
    assert.equal(r.json.result.structuredContent.mode, 'mock');
    assert.deepEqual(lastGrant.sort(), ['messages.read']);
  });

  it('accepts /bridge with a query string, and closes the older bridge with 4000 when a newer one connects', async () => {
    const older = bridge!;
    const closed = closeCode(older);
    bridge = await connectBridge(SECRET, '/bridge?v=2');
    assert.equal(await closed, CLOSE_REPLACED_BY_NEWER);
    assert.ok(hub.connected());
    const r = await rpc('tools/call', { name: 'get_status', arguments: { intent: 'relay test of a forwarded call' } });
    assert.equal(r.json.result.structuredContent.mode, 'mock');
  });

  it('falls back to the hello tool list after the bridge leaves', async () => {
    bridge!.close();
    await waitFor(() => !hub.connected(), 'the hub to see the bridge leave');
    assert.equal((await rpc('tools/list')).json.result.tools[0].name, 'from_hello');
    assert.match(
      (await rpc('tools/call', { name: 'find', arguments: { query: 'x' } })).json.result.content[0].text,
      /offline \(last seen/,
    );
  });
});

describe('relay hub: initialize while the Mac is offline', () => {
  const instructionsOf = async (hub: RelayHub) => {
    const r = await hub.offline({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    return (r.json as { result: { instructions: string } }).result.instructions;
  };
  const hello = { type: 'hello', version: 't', mode: 'live', toolsList: { tools: [] }, me: 'x' } as const;

  it("repeats the bridge's instructions from its hello, so they follow the bridge's REDACT_CODES", async () => {
    const hub = new RelayHub(async () => ({ tools: [] }), 'America/New_York', 'gateway fallback');
    assert.equal(await instructionsOf(hub), 'gateway fallback');
    hub.hello = { ...hello, instructions: serverInstructions(false) };
    assert.equal(await instructionsOf(hub), serverInstructions(false));
    // A bridge from before the instructions field: the fallback again.
    hub.hello = { ...hello };
    assert.equal(await instructionsOf(hub), 'gateway fallback');
  });

  it('falls back to the codes-hidden instructions when none are given', async () => {
    assert.equal(
      await instructionsOf(new RelayHub(async () => ({ tools: [] }), 'America/New_York')),
      SERVER_INSTRUCTIONS,
    );
  });
});

describe('bridge upgrade: frame size', () => {
  it('closes a bridge connection that sends a frame over maxPayload (1009), and the hub survives it', async () => {
    const hub = new RelayHub(async () => ({ tools: [] }), 'America/New_York');
    const server = serve({ fetch: () => new Response('ok'), port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    attachBridgeUpgrade(server, hub, SECRET, { maxPayload: 1024 });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { lines } = await captureConsole(async () => {
        const ws = await openSocket(`Bearer ${SECRET}`, '/bridge', url);
        await waitFor(() => hub.connected(), 'the hub to attach the bridge');
        const closed = closeCode(ws);
        ws.send('x'.repeat(2048));
        assert.equal(await closed, 1009);
        await waitFor(() => !hub.connected(), 'the hub to drop the bridge');
      });
      assert.ok(
        lines.some((l) => /bridge socket error: .*Max payload/i.test(l)),
        lines.join('\n'),
      );
    } finally {
      server.close();
    }
  });
});
