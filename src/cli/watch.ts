// `imessage watch`: prints new messages (and read receipts with --receipts) as they arrive, by long-polling get_updates.

import { MAX_UPDATE_HOLD_S } from '../lib/limits.js';
import { type Parsed, parseDuration, str } from './args.js';
import type { CustomCommand } from './command.js';
import { CliError, EXIT } from './errors.js';
import { failExit } from './output.js';
import { asString, type Bridge, objs, type ToolResult } from './transport.js';

/** The parts of a get_updates event that watch prints. */
interface UpdateEvent {
  type?: string;
  at?: string;
  chat_id?: string;
  chat_title?: string;
  message?: {
    message_id?: string;
    text?: string;
    read_at?: string;
    from?: 'me' | { person_id?: string; name?: string };
    attachments?: { kind?: string }[];
  };
}

async function watch(p: Parsed, bridge: Bridge): Promise<number> {
  const chatHasPerson = personInChat(bridge);
  let fromPid: string | undefined,
    fromName: string | undefined,
    chatId: string | undefined,
    chatTitle: string | undefined;
  if (str(p, 'from')) {
    const r = await bridge.tool('get_person', { person: str(p, 'from'), include_groups: false, include_stats: false });
    if (r.isError) {
      process.stderr.write(`${r.text}\n`);
      return failExit(r.text);
    }
    fromPid = asString(r.structured?.person_id);
    fromName = asString(r.structured?.name);
  }
  if (str(p, 'chat')) {
    const r = await bridge.tool('get_conversation', {
      chat: str(p, 'chat'),
      include_stats: false,
      include_history: false,
    });
    if (r.isError) {
      process.stderr.write(`${r.text}\n`);
      return failExit(r.text);
    }
    chatId = asString(r.structured?.chat_id);
    chatTitle = asString(r.structured?.title);
  }
  const timeout = str(p, 'timeout');
  const deadline = timeout ? Date.now() + parseDuration(timeout) : Infinity;
  const includeMine = !!p.flags['include-mine'];
  let baselineError = '';
  const baseline = async (): Promise<string | null> => {
    const r = await bridge.tool('get_updates', { cursor: 'now' });
    const next = asString(r.structured?.next_cursor);
    if (r.isError || !next) {
      baselineError = r.isError ? r.text : 'Error unexpected_reply: get_updates returned no cursor.';
      process.stderr.write(`${baselineError}\n`);
      return null;
    }
    return next;
  };
  let cursor = await baseline();
  if (cursor === null) return failExit(baselineError);
  process.stderr.write(
    `Watching for new messages${fromName ? ` from ${fromName}` : ''}${chatTitle ? ` in ${chatTitle}` : ''}${p.flags.once ? ' (stops at the first one)' : ''}${timeout ? `, up to ${timeout}` : ''}. Ctrl-C to stop.\n`,
  );
  while (Date.now() < deadline) {
    const wait = Math.max(1, Math.min(MAX_UPDATE_HOLD_S, Math.floor((deadline - Date.now()) / 1000)));
    let r: ToolResult;
    // from covers every handle and 1:1 thread of the person, so other chats' traffic doesn't end the server's hold.
    try {
      r = await bridge.tool(
        'get_updates',
        {
          cursor,
          wait_seconds: wait,
          types: p.flags.receipts ? ['new', 'read'] : ['new'],
          ...(chatId ? { chat: chatId } : {}),
          ...(fromPid ? { from: fromPid } : {}),
        },
        (wait + 30) * 1000,
      );
    } catch (e) {
      if (e instanceof CliError && e.exitCode === EXIT.offline) {
        process.stderr.write(`${e.message}\nRetrying in 10 s…\n`);
        await new Promise((res) => setTimeout(res, 10_000));
        continue;
      }
      throw e;
    }
    if (r.isError && /^Error cursor_expired/.test(r.text)) {
      // The bridge restarted (or the log rolled over): start again from now rather than giving up.
      process.stderr.write(
        'The bridge restarted; changes during the restart may have been missed (check with: imessage catchup --since 1h). Watching again from now.\n',
      );
      const fresh = await baseline();
      if (fresh === null) return failExit(baselineError);
      cursor = fresh;
      continue;
    }
    if (r.isError) {
      process.stderr.write(`${r.text}\n`);
      return failExit(r.text);
    }
    cursor = asString(r.structured?.next_cursor) ?? cursor;
    for (const ev of objs(r.structured?.events) as UpdateEvent[]) {
      const m = ev.message ?? {};
      const sender = typeof m.from === 'object' ? m.from : undefined;
      if (ev.type === 'read') {
        // A read receipt on one of your messages. In a 1:1 chat the reader is the other person.
        if (fromPid && !(await chatHasPerson(ev.chat_id ?? '', fromPid))) continue;
        if (p.flags.json) process.stdout.write(`${JSON.stringify(ev)}\n`);
        else
          process.stdout.write(
            `[${String(m.read_at ?? ev.at)
              .replace('T', ' ')
              .slice(
                0,
                16,
              )}] Read by ${ev.chat_title}: ${m.text || '[attachment]'}  #${m.message_id}  chat_id ${ev.chat_id}\n`,
          );
        if (p.flags.once) return EXIT.ok;
        continue;
      }
      if (m.from === 'me' && !includeMine) continue;
      if (fromPid && sender?.person_id !== fromPid) continue;
      if (p.flags.json) process.stdout.write(`${JSON.stringify(ev)}\n`);
      else {
        const who = m.from === 'me' ? 'You' : (sender?.name ?? 'Someone');
        const body =
          m.text || (m.attachments?.length ? `[${m.attachments.map((a) => a.kind ?? 'attachment').join(', ')}]` : '');
        process.stdout.write(
          `[${String(ev.at).replace('T', ' ').slice(0, 16)}] ${who} in ${ev.chat_title}: ${body}  #${m.message_id}  chat_id ${ev.chat_id}\n`,
        );
      }
      if (p.flags.once) return EXIT.ok;
    }
  }
  process.stderr.write(`No matching message within ${timeout}.\n`);
  return EXIT.timeout;
}

/** Whether a person is in a chat, from get_conversation; each chat is looked up once per watch. */
function personInChat(bridge: Bridge) {
  const chatPeople = new Map<string, string[]>();
  return async (chatId: string, personId: string): Promise<boolean> => {
    if (!chatPeople.has(chatId)) {
      const r = await bridge.tool('get_conversation', { chat: chatId, include_stats: false, include_history: false });
      chatPeople.set(
        chatId,
        objs(r.structured?.participants).flatMap((x) => asString(x.person_id) ?? []),
      );
    }
    return chatPeople.get(chatId)!.includes(personId);
  };
}

export const watchCommand: CustomCommand = {
  usage: 'watch [--from who] [--chat c] [--receipts] [--once] [--timeout 30min] [--include-mine] [--json]',
  summary:
    'Print new incoming messages (and with --receipts, when people read your messages) as they happen; --once exits on the first match',
  run: watch,
};
