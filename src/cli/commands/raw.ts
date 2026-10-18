// Raw access to the MCP tools: list them, or call any one with JSON arguments.

import { need } from '../args.js';
import type { Command } from '../command.js';
import { CliError, EXIT } from '../errors.js';
import { show } from '../output.js';
import { objs } from '../transport.js';

export const RAW_COMMANDS: Record<string, Command> = {
  tools: {
    usage: 'tools',
    summary: 'List the underlying MCP tools',
    run: async (_p, bridge) => {
      const r = await bridge.rpc('tools/list', {});
      for (const t of objs(r.tools))
        process.stdout.write(`${String(t.name).padEnd(20)} ${String(t.description ?? '').split('. ')[0]}.\n`);
      return EXIT.ok;
    },
  },
  call: {
    usage: 'call <tool> [\'{"json":"args"}\']',
    summary: 'Call any tool with raw JSON arguments',
    run: async (p, bridge) => {
      const name = need(p.pos[0], 'call <tool> [json]');
      let args = {};
      if (p.pos[1]) {
        try {
          args = JSON.parse(p.pos.slice(1).join(' '));
        } catch {
          throw new CliError('Arguments must be one JSON object.', EXIT.usage);
        }
      }
      return show(await bridge.tool(name, args), p);
    },
  },
};
