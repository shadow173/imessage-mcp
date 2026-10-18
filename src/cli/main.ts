// `imessage`: this Mac's iMessage tools from the terminal or any Claude Code session. Talks to the running bridge over
// its Unix socket (see transport.ts).

import { checkSocketPath, socketPath } from '../config.js';
import { VERSION } from '../lib/version.js';
import { parse, str } from './args.js';
import { runCommand } from './command.js';
import { COMMANDS } from './commands/index.js';
import { CliError, EXIT } from './errors.js';
import { connectBridge } from './transport.js';

const NO_INTENT = new Set(['tools', 'journal', 'mcp']);
const INTENT_HELP = `--intent TEXT (required)  The goal behind the workflow this command is part of, in plain language, not a
                          restatement of what the command does. Note internally what the command is doing, who it's for and
                          why; put the who and the why in the value, leave the action out. Stays on this Mac in the tool
                          journal (imessage journal) so the owner can tune these tools. Never include codes or passwords.
                          IMESSAGE_INTENT in the environment is used when the flag is absent.`;
function help(): string {
  const lines = ['imessage: read, search and send iMessages on this Mac through the iMessage bridge.', '', 'Commands:'];
  for (const [name, c] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(13)} ${c.summary}`);
  lines.push(
    '',
    'Global: --intent "<goal>" (required on every command that reads or sends; see --help), --json (structured output), --help on any command for its flags. imessage --version prints the version.',
    'Times: 2026-10-01, 2026-10-01T18:00, 30min, 3h, 2d, 1w, 6mo, 1y, "3 days ago", today, yesterday, last week, 2026-10 (whole month). Owner\'s time zone. A bare "m" is refused: write 30min or 6mo.',
    'Future times (draft --at, remind): 30min, 2h, tomorrow 09:00, 2026-10-18T09:00; a date alone means 09:00.',
    'Chats: a chat_id, a group name, or a person (their 1:1 chat). People: a name, alias, phone, email or person_id.',
    'Exit codes: 0 ok · 1 error · 2 watch timed out · 3 needs --confirm (recipient outside the allowlist, or leaving a group) · 4 ambiguous name (candidates printed; pass a person_id or chat_id) · 5 bridge not running · 64 bad usage.',
    'Wait for someone in the background (Claude Code): imessage watch --from "Sam" --once --timeout 2h',
  );
  return lines.join('\n');
}

async function main(): Promise<number> {
  const [cmdName, ...argv] = process.argv.slice(2);
  if (!cmdName || cmdName === 'help' || cmdName === '--help' || cmdName === '-h') {
    process.stdout.write(`${help()}\n`);
    return EXIT.ok;
  }
  if (cmdName === '--version' || cmdName === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }
  const cmd = COMMANDS[cmdName];
  if (!cmd) {
    process.stderr.write(`Unknown command "${cmdName}".\n\n${help()}\n`);
    return EXIT.usage;
  }
  const p = parse(argv);
  if (p.flags.help || p.flags.h) {
    process.stdout.write(`imessage ${cmd.usage} --intent "<goal>"\n  ${cmd.summary}\n\n${INTENT_HELP}\n`);
    return EXIT.ok;
  }
  const intent = str(p, 'intent') ?? process.env.IMESSAGE_INTENT;
  if (!NO_INTENT.has(cmdName) && (!intent || intent.trim().length < 8)) {
    throw new CliError(
      `--intent is required.\n\n${INTENT_HELP}\n\nExample: imessage ${cmdName} ... --intent "User wants to know whether Sam confirmed dinner"`,
      EXIT.usage,
    );
  }
  const path = socketPath();
  try {
    checkSocketPath(path);
  } catch (e) {
    throw new CliError((e as Error).message, EXIT.error);
  }
  const bridge = connectBridge({ socketPath: path, client: ('client' in cmd && cmd.client) || 'cli', intent });
  return runCommand(cmd, p, bridge);
}

// exitCode, not exit(): on macOS a piped stdout is async, and exit() would cut a long reply (tools/list) at 64 KiB.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = e.exitCode;
      return;
    }
    process.stderr.write(`Unexpected error: ${(e as Error).stack ?? e}\n`);
    process.exitCode = EXIT.error;
  },
);
