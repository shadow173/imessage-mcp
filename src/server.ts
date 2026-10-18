import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolConfig } from './config.js';
import { VERSION } from './lib/version.js';
import { serverInstructions } from './mcp/instructions.js';
import { CHATGPT_TOOLS } from './tools/chatgpt/index.js';
import type { Ctx } from './tools/context.js';
import { FIND_TOOLS } from './tools/find/index.js';
import { MEDIA_TOOLS } from './tools/media/index.js';
import { ORGANIZE_TOOLS } from './tools/organize/index.js';
import { PEOPLE_TOOLS } from './tools/people/index.js';
import { PRIVATE_API_TOOLS } from './tools/privateApi/index.js';
import { READ_TOOLS } from './tools/read/index.js';
import { registerTools, type ToolDef } from './tools/registry.js';
import { SEND_TOOLS } from './tools/send/index.js';

/** Every tool, in the order tools/list shows them. tools/catalog.ts lists the same names and tiers. */
export const ALL_TOOLS: readonly ToolDef[] = [
  ...FIND_TOOLS,
  ...READ_TOOLS,
  ...PEOPLE_TOOLS,
  ...MEDIA_TOOLS,
  ...SEND_TOOLS,
  ...ORGANIZE_TOOLS,
  ...PRIVATE_API_TOOLS,
  ...CHATGPT_TOOLS,
];

const newServer = (cfg: ToolConfig) =>
  new McpServer({ name: 'imessage', version: VERSION }, { instructions: serverInstructions(cfg.redactCodes) });

/** The MCP server for one request: the tools whose tier is on, running against ctx. */
export function buildServer(ctx: Ctx): McpServer {
  const server = newServer(ctx.cfg);
  registerTools(server, ALL_TOOLS, ctx.cfg, ctx);
  return server;
}

/** The same tools for listing only: it needs no store, and its tools can't be called. */
export function buildListServer(cfg: ToolConfig): McpServer {
  const server = newServer(cfg);
  registerTools(server, ALL_TOOLS, cfg);
  return server;
}
