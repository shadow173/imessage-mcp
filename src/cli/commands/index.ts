import type { Command } from '../command.js';
import { journalCommand } from '../journal.js';
import { mcpCommand } from '../mcpProxy.js';
import { watchCommand } from '../watch.js';
import { ORGANIZE_COMMANDS } from './organize.js';
import { PRIVATE_API_COMMANDS } from './privateApi.js';
import { RAW_COMMANDS } from './raw.js';
import { READ_COMMANDS } from './read.js';
import { SEND_COMMANDS } from './send.js';

/** Every command, in the order `imessage help` lists them. */
export const COMMANDS: Record<string, Command> = {
  ...READ_COMMANDS,
  ...SEND_COMMANDS,
  ...PRIVATE_API_COMMANDS,
  ...ORGANIZE_COMMANDS,
  watch: watchCommand,
  ...RAW_COMMANDS,
  mcp: mcpCommand,
  journal: journalCommand,
};
