import type { WebSocket } from 'ws';
import { fmtShort } from '../lib/time.js';
import { VERSION } from '../lib/version.js';
import { SERVER_INSTRUCTIONS } from '../mcp/instructions.js';
import { type BridgeToGateway, CLOSE_REPLACED_BY_NEWER, type GatewayToBridge, MAX_FRAME_BYTES } from './protocol.js';

type Pending = {
  resolve: (v: BridgeToGateway) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};
type Outgoing = GatewayToBridge extends infer F ? (F extends { id: number } ? Omit<F, 'id'> : never) : never;
type ToolInfo = { name: string; annotations?: { readOnlyHint?: boolean } };

/** dispatched: the request reached the bridge before it failed, so a write may have gone through. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly dispatched: boolean,
  ) {
    super(message);
  }
}

/** Never sent: the bridge's socket would refuse the frame and drop every other call in flight with it. */
export const FRAME_TOO_LARGE = 'request too large for the bridge connection';

/** Used when the bridge never sent hello: every tool that can change something. */
const WRITE_TOOLS = new Set([
  'send_message',
  'create_draft',
  'manage_drafts',
  'react',
  'edit_message',
  'unsend_message',
  'manage_group',
  'mark_read',
  'set_typing',
  'update_person',
  'label_conversation',
  'set_reminder',
]);

/** Holds the single Mac bridge connection and correlates requests with replies. */
export class RelayHub {
  private socket: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private heartbeat?: NodeJS.Timeout;
  private alive = false;
  lastSeen: number | null = null;
  hello: Extract<BridgeToGateway, { type: 'hello' }> | null = null;

  /**
   * fallbackTools and fallbackInstructions answer tools/list and initialize while the Mac is offline and hasn't sent a
   * hello since this process started (or its hello predates the instructions field).
   */
  constructor(
    private fallbackTools: () => Promise<unknown>,
    private timeZone: string,
    private fallbackInstructions: string = SERVER_INSTRUCTIONS,
  ) {}

  connected(): boolean {
    return !!this.socket && this.socket.readyState === 1;
  }

  /** Rejects every pending request: their socket is gone, so no reply will ever come. */
  private failPending(reason: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new BridgeError(reason, true));
    }
  }

  attach(ws: WebSocket) {
    if (this.socket) {
      this.failPending('bridge replaced by a newer connection');
      this.socket.close(CLOSE_REPLACED_BY_NEWER, 'replaced by a newer bridge connection');
    }
    this.socket = ws;
    this.alive = true;
    this.lastSeen = Date.now();
    console.log('bridge connected');
    // Without a listener an oversized frame (or any socket error) would crash the gateway; with it the socket just
    // closes.
    ws.on('error', (e) => console.error('bridge socket error:', e.message));
    ws.on('pong', () => {
      this.alive = true;
      this.lastSeen = Date.now();
    });
    ws.on('message', (data) => {
      this.lastSeen = Date.now();
      let frame: BridgeToGateway;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (frame.type === 'hello') {
        this.hello = frame;
        console.log(
          `bridge hello: v${frame.version}, ${frame.mode}${frame.tiers ? `, tiers ${frame.tiers.join(',')}` : ''}`,
        );
        void this.compareTools(frame);
        return;
      }
      const p = this.pending.get(frame.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      p.resolve(frame);
    });
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = null;
      clearInterval(this.heartbeat);
      console.log('bridge disconnected');
      this.failPending('bridge disconnected');
    });
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.socket !== ws) return;
      if (!this.alive) {
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.ping();
    }, 20_000);
    this.heartbeat.unref();
  }

  /**
   * The fallback list (served before the first hello after a deploy) follows the gateway's TIERS; warn when it differs
   * from the bridge's.
   */
  private async compareTools(hello: Extract<BridgeToGateway, { type: 'hello' }>) {
    try {
      const names = (list: unknown) =>
        new Set(((list as { tools?: ToolInfo[] } | undefined)?.tools ?? []).map((t) => t.name));
      const bridge = names(hello.toolsList);
      const gateway = names(await this.fallbackTools());
      const extra = [...gateway].filter((n) => !bridge.has(n));
      const missing = [...bridge].filter((n) => !gateway.has(n));
      if (extra.length || missing.length) {
        console.warn(
          `gateway fallback tool list differs from the bridge (${extra.length ? `extra: ${extra.join(', ')}` : ''}${extra.length && missing.length ? '; ' : ''}${missing.length ? `missing: ${missing.join(', ')}` : ''}). Set TIERS on the gateway to ${hello.tiers?.join(',') ?? "the bridge's TIERS"}.`,
        );
      }
    } catch (e) {
      console.warn('could not compare tool lists:', (e as Error).message);
    }
  }

  request(frame: Outgoing, timeoutMs: number): Promise<BridgeToGateway> {
    const ws = this.socket;
    if (ws?.readyState !== 1) return Promise.reject(new BridgeError('bridge offline', false));
    const id = this.nextId++;
    const data = JSON.stringify({ ...frame, id });
    if (Buffer.byteLength(data) > MAX_FRAME_BYTES - 1024)
      return Promise.reject(new BridgeError(FRAME_TOO_LARGE, false));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('bridge timed out', true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(data);
    });
  }

  private seen(): string {
    return this.lastSeen ? ` (last seen ${fmtShort(this.lastSeen, this.timeZone, Date.now())})` : '';
  }

  private isReadOnly(name: string | undefined): boolean {
    const tools = (this.hello?.toolsList as { tools?: ToolInfo[] } | undefined)?.tools;
    const t = tools?.find((x) => x.name === name);
    if (t) return t.annotations?.readOnlyHint === true;
    return !!name && !WRITE_TOOLS.has(name) && !tools;
  }

  /**
   * Answers MCP traffic while the Mac is away, so the connector stays healthy and tool calls explain themselves.
   * afterDispatch (the request reached the bridge before it failed: BridgeError.dispatched) answers writes with
   * outcome_unknown instead of "offline".
   */
  async offline(body: unknown, opts?: { afterDispatch?: boolean }): Promise<{ status: number; json?: unknown }> {
    const msgs = Array.isArray(body) ? body : [body];
    const dispatched = !!opts?.afterDispatch;
    const out: unknown[] = [];
    for (const m of msgs as {
      id?: unknown;
      method?: string;
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
    }[]) {
      if (m?.id === undefined || m.id === null) continue;
      const reply = (result: unknown) => out.push({ jsonrpc: '2.0', id: m.id, result });
      const error = (text: string) => reply({ isError: true, content: [{ type: 'text', text }] });
      if (m.method === 'initialize')
        reply({
          protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'imessage', version: this.hello?.version ?? VERSION },
          instructions: this.hello?.instructions ?? this.fallbackInstructions,
        });
      else if (m.method === 'tools/list')
        reply((this.hello?.toolsList as object | undefined) ?? (await this.fallbackTools()));
      else if (m.method === 'ping') reply({});
      else if (m.method === 'tools/call' && dispatched && this.isReadOnly(m.params?.name)) {
        error(
          `Error mac_unavailable: The Mac stopped answering mid-request${this.seen()}.\nFix: This was read-only, so it is safe to try again in a moment (narrow the request if it was large).`,
        );
      } else if (m.method === 'tools/call' && dispatched) {
        const key = m.params?.arguments?.idempotency_key;
        error(
          `Error outcome_unknown: The Mac stopped answering mid-request${this.seen()}; it may have gone through.\nFix: Don't tell the user it failed. When the Mac is back, check read_conversation or get_message first. For send_message, retry only with the SAME idempotency_key${typeof key === 'string' ? ` (${key})` : ''}. For other tools, retry only if the check shows nothing happened.`,
        );
      } else if (m.method === 'tools/call')
        error(
          `Error mac_offline: The Mac that holds the messages is offline${this.seen()}.\nFix: Tell the user that messages can't be read or sent until the Mac reconnects. Try again later.`,
        );
      else out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    }
    if (!out.length) return { status: 202 };
    return { status: 200, json: Array.isArray(body) ? out : out[0] };
  }
}
