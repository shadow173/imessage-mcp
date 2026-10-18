import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer } from '../../src/server.js';
import type { Ctx } from '../../src/tools/context.js';

/** A tools/call result as the SDK client returns it. structuredContent stays loose: each tool has its own shape. */
export interface Result {
  isError?: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  /** Loose: assertions reach into each tool's own output shape. */
  structuredContent?: any;
  _meta?: any;
}

/** The text blocks of a result, joined. */
export const text = (r: Result) =>
  r.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');

/** The code of an error result ("Error <code>: ..."), or undefined for a success. */
export const errCode = (r: Result) => (r.isError ? /^Error (\w+):/.exec(text(r))?.[1] : undefined);

/** Connects an in-memory client to a server. */
export async function connect(server: McpServer, name = 'test'): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name, version: '1' });
  await client.connect(b);
  return client;
}

/** Builds the full tool server on ctx and returns a client plus call(), which adds the required intent. */
export async function connectTools(ctx: Ctx, intent = 'automated test of the iMessage tools') {
  const client = await connect(buildServer(ctx));
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: { intent, ...args } })) as Result;
  return { client, call };
}
