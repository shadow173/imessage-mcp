// `imessage mcp`: a stdio MCP server for Claude Code that passes each JSON-RPC line to the bridge and prints its reply.

import { createInterface } from 'node:readline';
import type { CustomCommand } from './command.js';
import { EXIT } from './errors.js';
import { type Bridge, isObj } from './transport.js';

async function mcpProxy(bridge: Bridge): Promise<number> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inflight = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
      continue;
    }
    const job = (async () => {
      try {
        const r = await bridge.post(msg, 0);
        if (r.status !== 202 && r.text.trim()) process.stdout.write(`${r.text.trim()}\n`);
      } catch (e) {
        const id = isObj(msg) ? msg.id : undefined;
        if (id !== undefined)
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } })}\n`,
          );
      }
    })();
    inflight.add(job);
    void job.finally(() => inflight.delete(job));
  }
  await Promise.all(inflight);
  return EXIT.ok;
}

export const mcpCommand: CustomCommand = {
  usage: 'mcp',
  summary: 'Run as a stdio MCP server (claude mcp add imessage -- imessage mcp)',
  client: 'mcp',
  run: (_p, bridge) => mcpProxy(bridge),
};
