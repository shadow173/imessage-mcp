// The bridge's side of the relay: it dials the gateway, says hello, answers frames, and reconnects with backoff.

import WebSocket from 'ws';
import {
  type BridgeToGateway,
  CLOSE_REPLACED_BY_NEWER,
  type GatewayToBridge,
  MAX_FRAME_BYTES,
} from '../relay/protocol.js';
import { fitFrame } from './frames.js';

const DEFAULT_TIMING = {
  firstRetryMs: 1000,
  maxRetryMs: 30_000,
  /** Added at random to each retry, so bridges restarted together don't reconnect in lockstep. */
  jitterMs: 500,
  /** The gateway pings every 20 s; without one for this long the connection is dead even if the socket doesn't know. */
  pingTimeoutMs: 70_000,
  watchdogMs: 15_000,
  handshakeTimeoutMs: 15_000,
};
export type GatewayTiming = typeof DEFAULT_TIMING;

export interface GatewayClientOptions {
  /** GATEWAY_URL: the gateway's http(s) origin. */
  url: string;
  /** BRIDGE_SECRET, sent as a Bearer token. */
  secret: string;
  /** The hello frame, built fresh for each connection. */
  hello: () => Promise<BridgeToGateway>;
  handle: (frame: GatewayToBridge) => Promise<BridgeToGateway>;
  /** The gateway kept a newer bridge's connection (close code 4000). The client stops; reconnecting would fight it. */
  onReplaced: () => void;
  /** For tests: a fake socket in place of a real WebSocket, and shorter timers. */
  createSocket?: (url: string, opts: WebSocket.ClientOptions) => WebSocket;
  timing?: Partial<GatewayTiming>;
}

export interface GatewayClient {
  /** Closes the connection and stops reconnecting. */
  close(): void;
  connected(): boolean;
}

/** Connects to the gateway and keeps the connection up until close() or a newer bridge replaces it. */
export function connectGateway(o: GatewayClientOptions): GatewayClient {
  const t = { ...DEFAULT_TIMING, ...o.timing };
  const createSocket = o.createSocket ?? ((url, opts) => new WebSocket(url, opts));
  const url = `${o.url.replace(/^http/, 'ws')}/bridge`;
  let ws: WebSocket | null = null;
  let backoff = t.firstRetryMs;
  let lastPing = Date.now();
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;

  function connect() {
    const sock = createSocket(url, {
      headers: { Authorization: `Bearer ${o.secret}` },
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: t.handshakeTimeoutMs,
    });
    ws = sock;
    sock.on('open', async () => {
      lastPing = Date.now();
      console.log(`connected to ${o.url}`);
      try {
        sock.send(JSON.stringify(await o.hello()));
        backoff = t.firstRetryMs;
      } catch (e) {
        // Without a hello the gateway can't use this connection; drop it and retry with backoff.
        console.error('hello failed:', (e as Error).message);
        sock.terminate();
      }
    });
    sock.on('ping', () => {
      lastPing = Date.now();
    });
    sock.on('message', async (data) => {
      let frame: GatewayToBridge;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        const reply = await o.handle(frame);
        if (sock.readyState === WebSocket.OPEN) sock.send(fitFrame(frame, reply));
      } catch (e) {
        console.error(`request ${frame.type} failed:`, (e as Error).message);
        if (frame.type === 'mcp' && sock.readyState === WebSocket.OPEN)
          sock.send(
            JSON.stringify({
              type: 'mcp_result',
              id: frame.id,
              status: 500,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Bridge error' } }),
            } satisfies BridgeToGateway),
          );
      }
    });
    sock.on('unexpected-response', (_req, res) => {
      console.error(
        `gateway refused the bridge: HTTP ${res.statusCode}${res.statusCode === 401 ? ' (BRIDGE_SECRET mismatch)' : ''}`,
      );
    });
    sock.on('error', (e) => {
      console.error('connection error:', e.message);
    });
    sock.on('close', (code) => {
      if (ws !== sock) return;
      ws = null;
      if (stopped) return;
      if (code === CLOSE_REPLACED_BY_NEWER) {
        stop();
        o.onReplaced();
        return;
      }
      const wait = Math.min(backoff, t.maxRetryMs) + Math.floor(Math.random() * t.jitterMs);
      console.log(`disconnected; retrying in ${Math.round(wait / 1000)} s`);
      retry = setTimeout(connect, wait);
      backoff = Math.min(backoff * 2, t.maxRetryMs);
    });
  }

  const watchdog = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastPing > t.pingTimeoutMs) {
      console.log('no ping from gateway; reconnecting');
      ws.terminate();
    }
  }, t.watchdogMs);
  watchdog.unref();

  function stop() {
    stopped = true;
    clearInterval(watchdog);
    clearTimeout(retry);
  }

  connect();
  return {
    close() {
      stop();
      ws?.close();
    },
    connected: () => ws?.readyState === WebSocket.OPEN,
  };
}
