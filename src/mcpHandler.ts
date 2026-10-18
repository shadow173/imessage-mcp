import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ToolConfig } from './config.js';
import { sanitizeArgs } from './lib/journal.js';
import { buildListServer, buildServer } from './server.js';
import { scopeOf } from './tools/catalog.js';
import type { Ctx } from './tools/context.js';
import { tierOffResult } from './tools/registry.js';

export interface McpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type RpcMessage = {
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
  result?: {
    tools?: { name: string; securitySchemes?: unknown }[];
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  error?: { message?: string };
};
const messages = (json: unknown) => (Array.isArray(json) ? json : [json]) as RpcMessage[];
export const isToolsList = (body: unknown) => messages(body).some((m) => m?.method === 'tools/list');

/** The ToolError code ("Error send_disabled: ..."), or what the SDK rejected before the tool ran. */
function errorCode(text: string): string {
  if (/-32602/.test(text)) return /\bintent\b/.test(text) ? 'missing_intent' : 'invalid_arguments';
  return text.match(/^Error ([a-z_]+):/)?.[1] ?? 'tool_error';
}

/**
 * Journals every tools/call, including calls rejected before the tool ran (bad arguments, missing intent, tier off).
 */
function journalCalls(ctx: Ctx, body: unknown, responseText: string, startedAt: number) {
  if (!ctx.journal) return;
  const calls = messages(body).filter((m) => m?.method === 'tools/call');
  if (!calls.length) return;
  let replies: RpcMessage[] = [];
  try {
    replies = messages(JSON.parse(responseText));
  } catch {
    /* journal what we know */
  }
  const ms = Date.now() - startedAt;
  for (const call of calls) {
    const reply = replies.find((r) => r?.id === call.id);
    const texts = (reply?.result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    const ok = !!reply?.result && !reply.result.isError;
    const errText = reply?.error?.message ?? (ok ? '' : texts);
    const args = call.params?.arguments ?? {};
    ctx.journal({
      at: startedAt,
      client: ctx.client ?? 'unknown',
      tool: call.params?.name ?? '?',
      intent: typeof args.intent === 'string' ? args.intent : null,
      args: sanitizeArgs(args),
      ok,
      ...(ok ? {} : { errorCode: errorCode(errText), error: errText.slice(0, 300) }),
      ms,
      outChars: texts.length,
    });
  }
}

/** ChatGPT reads per-tool scopes from a top-level `securitySchemes` field the SDK doesn't emit. */
function addSecuritySchemes(json: unknown): unknown {
  for (const m of messages(json)) {
    for (const t of m?.result?.tools ?? []) {
      const scope = scopeOf(t.name);
      if (scope) t.securitySchemes = [{ type: 'oauth2', scopes: [scope] }];
    }
  }
  return json;
}

/**
 * Runs one stateless MCP request (single or batch JSON-RPC) against the tools. Used by the gateway's mock mode and the
 * Mac bridge.
 */
export async function handleMcp(ctx: Ctx, body: unknown): Promise<McpResult> {
  const startedAt = Date.now();
  const server = buildServer(ctx);
  try {
    // Calls to a tool whose tier is off get a reason and a next step here; the SDK would only say "Tool X not found".
    const answered: { jsonrpc: '2.0'; id: unknown; result: unknown }[] = [];
    const rest = messages(body).filter((m) => {
      const result =
        m?.method === 'tools/call' && m.id !== undefined ? tierOffResult(ctx.cfg, m.params?.name) : undefined;
      if (result) answered.push({ jsonrpc: '2.0', id: m.id, result });
      return !result;
    });
    if (answered.length && !rest.length) {
      const text = JSON.stringify(Array.isArray(body) ? answered : answered[0]);
      journalCalls(ctx, body, text, startedAt);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: text };
    }
    const forward = answered.length ? rest : body;
    const res = await runServer(server, forward);
    const { headers } = res;
    let { status, body: text } = res;
    if (answered.length) {
      let replies: unknown[] = [];
      try {
        replies = text ? messages(JSON.parse(text)) : [];
      } catch {
        /* keep ours */
      }
      text = JSON.stringify([...replies, ...answered]);
      status = 200;
      headers['content-type'] = 'application/json';
    }
    journalCalls(ctx, body, text, startedAt);
    return { status, headers, body: text };
  } finally {
    void server.close();
  }
}

/** Runs a JSON-RPC body through server on the SDK's stateless HTTP transport, adding securitySchemes to tools/list. */
async function runServer(server: McpServer, body: unknown): Promise<McpResult> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 15 * 1024 * 1024,
  });
  try {
    await server.connect(transport);
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    const res = await transport.handleRequest(req, { parsedBody: body });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== 'content-length') headers[k] = v;
    });
    let text = await res.text();
    if (text && isToolsList(body) && (headers['content-type'] ?? '').includes('application/json'))
      text = JSON.stringify(addSecuritySchemes(JSON.parse(text)));
    return { status: res.status, headers, body: text };
  } finally {
    void transport.close();
  }
}

/**
 * The tools/list result for cfg's tiers, exactly as a bridge with that config serves it, without a store. The gateway
 * answers with it until the Mac's first hello.
 */
export async function listTools(cfg: ToolConfig): Promise<unknown> {
  const server = buildListServer(cfg);
  try {
    const r = await runServer(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    return JSON.parse(r.body).result;
  } finally {
    void server.close();
  }
}
