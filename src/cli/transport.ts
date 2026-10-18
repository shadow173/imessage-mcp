// The connection to the running bridge: HTTP over its Unix socket, which only processes running as this macOS user can
// open. No internet, no OAuth.

import { request } from 'node:http';
import { CliError, EXIT } from './errors.js';

// Replies come from the local bridge; these guards check the shape before anything reads a field.
export type Json = Record<string, unknown>;
export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const objs = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);
export const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function parseReply(r: { status: number; text: string }): Json {
  let msg: unknown;
  try {
    msg = JSON.parse(r.text);
  } catch {
    /* handled below */
  }
  if (!isObj(msg)) throw new CliError(`Unexpected reply from the bridge (HTTP ${r.status}).`, EXIT.error);
  return msg;
}

export interface ToolResult {
  text: string;
  structured?: Json;
  isError: boolean;
  images: { data: string; mimeType: string }[];
}

export interface Bridge {
  /** One HTTP request on the socket. timeoutMs 0 waits forever. */
  post(body: unknown, timeoutMs?: number, path?: string, method?: string): Promise<{ status: number; text: string }>;
  /** A JSON-RPC call to /mcp; a JSON-RPC error becomes a CliError. */
  rpc(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Json>;
  /** tools/call with the command's intent added. */
  tool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
}

/**
 * A connection to the bridge at socketPath. client labels the calls in the bridge's journal (cli, mcp); intent, the
 * goal behind the command, goes with every tool call.
 */
export function connectBridge(o: { socketPath: string; client: string; intent?: string }): Bridge {
  const { socketPath, client, intent } = o;
  let rpcId = 1;

  function post(
    body: unknown,
    timeoutMs = 120_000,
    path = '/mcp',
    method = 'POST',
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const data = method === 'POST' ? JSON.stringify(body) : '';
      const req = request(
        {
          socketPath,
          path,
          method,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(data),
            'x-imessage-client': client,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            text += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')
          reject(
            new CliError(
              `The iMessage bridge isn't running on this Mac (no socket at ${socketPath}).\nStart it: launchctl kickstart -k gui/$(id -u)/com.imessage-mcp.bridge`,
              EXIT.offline,
            ),
          );
        else if (e.code === 'EACCES')
          reject(
            new CliError(`Permission denied on ${socketPath}. Run this as the Mac's owner account.`, EXIT.offline),
          );
        else reject(new CliError(`Couldn't reach the bridge: ${e.message}`, EXIT.offline));
      });
      req.end(data);
    });
  }

  async function rpc(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Json> {
    const msg = parseReply(await post({ jsonrpc: '2.0', id: rpcId++, method, params }, timeoutMs));
    if (isObj(msg.error)) throw new CliError(`Bridge error: ${msg.error.message}`, EXIT.error);
    return isObj(msg.result) ? msg.result : {};
  }

  async function tool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult> {
    const clean = Object.fromEntries(Object.entries({ intent, ...args }).filter(([, v]) => v !== undefined));
    const r = await rpc('tools/call', { name, arguments: clean }, timeoutMs);
    const content = objs(r.content);
    return {
      text: content
        .filter((c) => c.type === 'text')
        .map((c) => asString(c.text) ?? '')
        .join('\n'),
      structured: isObj(r.structuredContent) ? r.structuredContent : undefined,
      isError: r.isError === true,
      images: content.flatMap((c) =>
        c.type === 'image' && typeof c.data === 'string'
          ? [{ data: c.data, mimeType: asString(c.mimeType) ?? 'image/jpeg' }]
          : [],
      ),
    };
  }

  return { post, rpc, tool };
}
