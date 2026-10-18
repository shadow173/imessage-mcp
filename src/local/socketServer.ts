import { chmodSync, lstatSync, mkdirSync, rmSync, type Stats } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { ALL_SCOPES } from '../auth/scopes.js';
import { checkSocketPath } from '../config.js';
import type { Journal } from '../lib/journal.js';
import { handleMcp } from '../mcpHandler.js';
import type { MessageStore } from '../store/ports.js';
import type { Ctx } from '../tools/context.js';

/**
 * The bridge's local door for tools on this Mac: the `imessage` CLI, and Claude Code through `imessage mcp`.
 * A Unix socket with mode 0600, so only processes running as this macOS user can connect. There is no OAuth and no
 * per-client scope: every such process gets all scopes, so it can read, organize and send. Sends go through the same
 * policy as the remote path (kill switch, allowlist, rate limit).
 */
export function startLocalServer(
  socketPath: string,
  store: MessageStore,
  ctxFor: (scopes: string[], client: string) => Ctx,
  journal?: Journal,
): Server {
  checkSocketPath(socketPath);
  // A directory created here is 0700. An existing one is left alone, since IMESSAGE_SOCKET can point anywhere.
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true, mode: store.mode, health: store.health?.() ?? {} }));
  // The owner's tool-call journal (who called which tool, why, and how it went). Local socket only; never exposed
  // remotely.
  app.get('/journal', (c) => {
    if (!journal) return c.json({ entries: [], timeZone: store.timeZone });
    const since = Number(c.req.query('since') ?? 0);
    return c.json({
      timeZone: store.timeZone,
      entries: journal.list({
        since,
        limit: Number(c.req.query('limit') ?? 200),
        client: c.req.query('client') || undefined,
        tool: c.req.query('tool') || undefined,
      }),
    });
  });
  app.post('/mcp', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400);
    }
    const r = await handleMcp(ctxFor(ALL_SCOPES, `local-${c.req.header('x-imessage-client') ?? 'socket'}`), body);
    return new Response(r.body || null, { status: r.status, headers: r.headers });
  });
  const server = createServer(getRequestListener(app.fetch));
  server.requestTimeout = 0; // get_updates long-polls
  claimSocket(server, socketPath);
  return server;
}

/**
 * Listens on the socket path. A socket file left by a bridge that died is replaced. One that a running bridge still
 * answers on is left alone, and this one retries until that bridge exits (it does once a newer bridge takes over the
 * gateway connection). Anything at the path that isn't a socket is never removed.
 */
function claimSocket(server: Server, path: string): void {
  let retry: NodeJS.Timeout | undefined;
  let closed = false;
  let warned = false;
  const tryListen = () => {
    if (closed) return;
    let st: Stats | undefined;
    try {
      st = lstatSync(path);
    } catch {
      /* nothing there */
    }
    if (!st) {
      server.listen(path);
      return;
    }
    if (!st.isSocket()) throw new Error(`${path} exists and is not a socket; refusing to replace it.`);
    void socketAnswers(path).then((live) => {
      if (closed) return;
      if (!live) {
        rmSync(path, { force: true });
        server.listen(path);
        return;
      }
      if (!warned) console.warn(`${path} is in use by another running bridge; waiting for it to exit.`);
      warned = true;
      retry = setTimeout(tryListen, 2_000);
      retry.unref();
    });
  };
  server.once('close', () => {
    closed = true;
    clearTimeout(retry);
  });
  server.on('listening', () => chmodSync(path, 0o600));
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE') throw e;
    tryListen(); // something claimed the path between the check and listen()
  });
  tryListen();
}

/** Whether a process is listening on the socket, as opposed to a file left behind by one that died. */
function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.setTimeout(1_000, () => {
      s.destroy();
      resolve(true);
    });
  });
}
