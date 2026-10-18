// `imessage journal`: the bridge's record of every tool call, with its intent and outcome.

import type { JournalEntry } from '../lib/journal.js';
import { fmtIso } from '../lib/time.js';
import { num, parseDuration, str } from './args.js';
import type { CustomCommand } from './command.js';
import { EXIT } from './errors.js';
import { asString, parseReply } from './transport.js';

export const journalCommand: CustomCommand = {
  usage:
    'journal [--since 7d] [--limit 100] [--client chatgpt|claude|local-cli|local-mcp] [--tool send_message] [--errors] [--json]',
  summary: 'Every tool call with its intent and outcome, for tuning the tools (stored on this Mac only)',
  run: async (p, bridge) => {
    const since = str(p, 'since');
    const q = new URLSearchParams({
      since: String(since ? Date.now() - parseDuration(since) : 0),
      limit: String(num(p, 'limit') ?? 100),
    });
    for (const k of ['client', 'tool']) {
      const v = str(p, k);
      if (v) q.set(k, v);
    }
    const reply = parseReply(await bridge.post(undefined, 30_000, `/journal?${q}`, 'GET'));
    // Times in the bridge's time zone; an older bridge doesn't send it, so fall back to this machine's.
    const tz = asString(reply.timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let entries: JournalEntry[] = Array.isArray(reply.entries) ? reply.entries : [];
    if (p.flags.errors) entries = entries.filter((e) => !e.ok);
    if (p.flags.json) {
      for (const e of entries) process.stdout.write(`${JSON.stringify(e)}\n`);
      return EXIT.ok;
    }
    if (!entries.length) {
      process.stdout.write('No tool calls recorded for that range.\n');
      return EXIT.ok;
    }
    for (const e of entries) {
      const when = fmtIso(e.at, tz).slice(0, 16).replace('T', ' ');
      process.stdout.write(
        `[${when}] ${e.client} · ${e.tool} · ${e.ok ? 'ok' : `error ${e.errorCode ?? ''}`} ${e.ms}ms · ${e.outChars} chars\n  intent: ${e.intent ?? '(none)'}\n  args: ${JSON.stringify(e.args).slice(0, 300)}\n${e.error ? `  error: ${String(e.error).split('\n')[0]}\n` : ''}`,
      );
    }
    return EXIT.ok;
  },
};
