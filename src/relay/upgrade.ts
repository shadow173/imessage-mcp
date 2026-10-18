import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { safeEqual } from '../auth/crypto.js';
import type { RelayHub } from './hub.js';
import { MAX_FRAME_BYTES } from './protocol.js';

/**
 * Accepts the Mac bridge's WebSocket on /bridge (any query string is ignored) when it presents `Authorization: Bearer
 * <secret>`, and hands it to the hub. Anything else gets a bare 401 and the socket is closed. A frame over maxPayload
 * closes the connection (1009) instead of being buffered.
 */
export function attachBridgeUpgrade(
  server: ServerType,
  hub: Pick<RelayHub, 'attach'>,
  secret: string,
  opts: { maxPayload?: number } = {},
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload ?? MAX_FRAME_BYTES });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    const auth = req.headers.authorization ?? '';
    if (path !== '/bridge' || !auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), secret)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws));
  });
  return wss;
}
