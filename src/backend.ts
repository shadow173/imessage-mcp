// Where the gateway's tool calls, file downloads and citation pages are answered: here against a store (mock mode), or
// on the Mac through the relay hub (relay mode). app.ts turns each reply into an HTTP response.

import { type AccessGrant, resourceMetadataUrl } from './auth/oauth.js';
import type { ToolConfig } from './config.js';
import { clientLabel } from './lib/journal.js';
import { handleMcp } from './mcpHandler.js';
import { BridgeError, FRAME_TOO_LARGE, type RelayHub } from './relay/hub.js';
import { MAX_FILE_BYTES } from './relay/protocol.js';
import type { MessageStore } from './store/ports.js';
import { chatTranscript, messageTranscript } from './tools/chatgpt/transcripts.js';
import type { Ctx } from './tools/context.js';

/** raw: an MCP response to pass on as is. json: a JSON-RPC body the gateway made. accepted: 202, no body. */
export type McpReply =
  | { kind: 'raw'; status: number; headers: Record<string, string>; body: string }
  | { kind: 'json'; status: 200 | 413 | 500; json: object }
  | { kind: 'accepted' };
export type FileReply =
  | { kind: 'file'; data: Uint8Array<ArrayBuffer> | string; mime: string | undefined; name: string }
  | { kind: 'error'; status: number; text: string };
export interface ViewReply {
  status: number;
  text: string;
}

export interface Backend {
  /** One authenticated JSON-RPC request (or batch); baseUrl is the gateway origin links are minted for. */
  mcp(body: unknown, grant: AccessGrant, baseUrl: string): Promise<McpReply>;
  /** An attachment for a /files link that already verified. */
  file(attachmentId: string, baseUrl: string): Promise<FileReply>;
  /** A citation page for a /view link that already verified; nothing newer than until (epoch ms). */
  view(kind: string, id: string, until: number, baseUrl: string): Promise<ViewReply>;
}

const MCP_ERROR = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });
export const TOO_LARGE = `This file is too large to download through this link (limit about ${Math.floor(MAX_FILE_BYTES / 1_000_000)} MB). Open it in Messages on the Mac.`;
const INTERNAL_ERROR: McpReply = { kind: 'json', status: 500, json: MCP_ERROR(-32603, 'Internal server error') };
const NOT_FOUND: ViewReply = { status: 404, text: 'Not found.' };
const MAC_OFFLINE = 'The Mac is offline.';
const UNEXPECTED_REPLY = 'unexpected bridge reply';

/** Mock mode: the tools run here, against the seeded store. */
export class LocalBackend implements Backend {
  constructor(
    private store: MessageStore,
    private cfg: ToolConfig,
    private sendLog: number[],
  ) {}

  private ctx(baseUrl: string, scopes: Set<string>, clientId?: string): Ctx {
    return {
      store: this.store,
      cfg: this.cfg,
      baseUrl,
      sendLog: this.sendLog,
      scopes,
      resourceMetadataUrl: resourceMetadataUrl(baseUrl),
      client: clientLabel(clientId),
    };
  }

  async mcp(body: unknown, grant: AccessGrant, baseUrl: string): Promise<McpReply> {
    try {
      return { kind: 'raw', ...(await handleMcp(this.ctx(baseUrl, grant.scopes, grant.clientId), body)) };
    } catch (err) {
      console.error('MCP request failed:', (err as Error).message);
      return INTERNAL_ERROR;
    }
  }

  async file(attachmentId: string): Promise<FileReply> {
    const a = this.store.attachment(attachmentId);
    if (!a) return { kind: 'error', status: 404, text: 'Not found.' };
    if (a.bytes > MAX_FILE_BYTES) return { kind: 'error', status: 413, text: TOO_LARGE };
    if (a.dataBase64)
      return { kind: 'file', data: Buffer.from(a.dataBase64, 'base64'), mime: 'image/png', name: a.name };
    return {
      kind: 'file',
      data: `[mock file] ${a.name}\n\n${a.extractedText ?? ''}`,
      mime: 'text/plain',
      name: a.name,
    };
  }

  async view(kind: string, id: string, until: number, baseUrl: string): Promise<ViewReply> {
    const ctx = this.ctx(baseUrl, new Set());
    if (kind === 'chat')
      return this.store.chat(id) ? { status: 200, text: chatTranscript(ctx, this.store, id, 50, until) } : NOT_FOUND;
    return this.store.message(id) ? { status: 200, text: messageTranscript(ctx, this.store, id, 5, until) } : NOT_FOUND;
  }
}

/** Relay mode: every call goes to the Mac over the bridge WebSocket, and the hub answers while it is away. */
export class RelayBackend implements Backend {
  constructor(private hub: Pick<RelayHub, 'connected' | 'request' | 'offline'>) {}

  private async offline(body: unknown, opts?: { afterDispatch: boolean }): Promise<McpReply> {
    const off = await this.hub.offline(body, opts);
    return off.json === undefined ? { kind: 'accepted' } : { kind: 'json', status: 200, json: off.json as object };
  }

  async mcp(body: unknown, grant: AccessGrant, baseUrl: string): Promise<McpReply> {
    try {
      if (!this.hub.connected()) return await this.offline(body);
      const r = await this.hub.request(
        { type: 'mcp', body, grant: { scopes: [...grant.scopes], clientId: grant.clientId }, baseUrl },
        110_000,
      );
      if (r.type !== 'mcp_result') throw new Error(UNEXPECTED_REPLY);
      return { kind: 'raw', status: r.status, headers: r.headers, body: r.body };
    } catch (err) {
      const message = (err as Error).message;
      console.error('MCP request failed:', message);
      if (message === FRAME_TOO_LARGE)
        return { kind: 'json', status: 413, json: MCP_ERROR(-32600, 'Request body too large.') };
      // Offline, disconnected mid-call or timed out. A call that reached the Mac may have gone through, so writes get
      // outcome_unknown rather than "offline".
      if (message !== UNEXPECTED_REPLY)
        return await this.offline(body, { afterDispatch: err instanceof BridgeError && err.dispatched });
      return INTERNAL_ERROR;
    }
  }

  async file(attachmentId: string, baseUrl: string): Promise<FileReply> {
    if (!this.hub.connected()) return { kind: 'error', status: 503, text: MAC_OFFLINE };
    const r = await this.hub.request({ type: 'file', attachmentId, baseUrl }, 60_000).catch(() => null);
    if (r?.type === 'file_result' && r.status === 413) return { kind: 'error', status: 413, text: TOO_LARGE };
    if (r?.type !== 'file_result' || r.status !== 200)
      return { kind: 'error', status: r && 'status' in r ? r.status : 502, text: 'Not available.' };
    const name = r.name ?? 'file';
    return r.base64
      ? { kind: 'file', data: Buffer.from(r.base64, 'base64'), mime: r.contentType, name }
      : { kind: 'file', data: r.text ?? '', mime: 'text/plain', name };
  }

  async view(kind: string, id: string, until: number, baseUrl: string): Promise<ViewReply> {
    if (!this.hub.connected()) return { status: 503, text: MAC_OFFLINE };
    // A variable, not a literal: `until` is a newer frame field that an older protocol type doesn't list yet.
    const frame = { type: 'view' as const, kind: kind as 'chat' | 'msg', target: id, baseUrl, until };
    const r = await this.hub.request(frame, 30_000).catch(() => null);
    return r && r.type === 'view_result' && r.status === 200 ? { status: 200, text: r.text } : NOT_FOUND;
  }
}
