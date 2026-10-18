import type { Parsed } from './args.js';
import { show } from './output.js';
import type { Bridge } from './transport.js';

interface CommandInfo {
  usage: string;
  summary: string;
}

/** Most commands map onto one tool: build turns the command line into that tool's arguments. */
export interface ToolCommand extends CommandInfo {
  tool: string;
  build: (p: Parsed) => Record<string, unknown>;
}

/** The rest drive the bridge themselves (watch, journal, the stdio proxy). */
export interface CustomCommand extends CommandInfo {
  /** Labels this command's calls in the bridge's journal instead of "cli". */
  client?: string;
  run: (p: Parsed, bridge: Bridge) => Promise<number>;
}

export type Command = ToolCommand | CustomCommand;

export const runCommand = async (cmd: Command, p: Parsed, bridge: Bridge): Promise<number> =>
  'tool' in cmd ? show(await bridge.tool(cmd.tool, cmd.build(p)), p) : cmd.run(p, bridge);
