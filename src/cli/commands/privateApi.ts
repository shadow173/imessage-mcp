// Commands for the Private API tools: tapbacks, edit, unsend, read receipts, typing and group changes.

import { readFileSync } from 'node:fs';
import { bool, need, num, rest, str } from '../args.js';
import type { Command } from '../command.js';
import { CliError, EXIT } from '../errors.js';

const GROUP_USAGE =
  'group create <person> <person>... [--name n] [--confirm] | group rename <chat> <name> | group add <chat> <person> [--confirm] | group remove <chat> <person> | group icon <chat> <image path>|--clear | group leave <chat> --confirm';

export const PRIVATE_API_COMMANDS: Record<string, Command> = {
  react: {
    usage:
      'react <message_id> <love|like|dislike|laugh|emphasize|question> [--part n] [--confirm] | react <message_id> --remove',
    summary: 'Tapback a message, or take yours back',
    tool: 'react',
    build: (p) => ({
      message_id: need(p.pos[0], 'react <message_id> <kind>'),
      reaction: bool(p, 'remove') ? p.pos[1] : need(p.pos[1], 'react <message_id> <kind>'),
      remove: bool(p, 'remove'),
      part: num(p, 'part'),
      user_confirmed: bool(p, 'confirm'),
    }),
  },
  edit: {
    usage: 'edit <message_id> <new text>',
    summary: 'Edit your sent iMessage (within 15 minutes)',
    tool: 'edit_message',
    build: (p) => ({
      message_id: need(p.pos[0], 'edit <message_id> <text>'),
      text: need(rest(p, 1), 'edit <message_id> <text>'),
    }),
  },
  unsend: {
    usage: 'unsend <message_id>',
    summary: 'Unsend your iMessage (within 2 minutes)',
    tool: 'unsend_message',
    build: (p) => ({ message_id: need(p.pos[0], 'unsend <message_id>') }),
  },
  'mark-read': {
    usage: 'mark-read <chat> [--unread]',
    summary: 'Mark a chat read or unread',
    tool: 'mark_read',
    build: (p) => ({ chat: need(rest(p, 0), 'mark-read <chat>'), unread: bool(p, 'unread') }),
  },
  typing: {
    usage: 'typing <chat> [--stop]',
    summary: 'Show or stop the typing indicator',
    tool: 'set_typing',
    build: (p) => ({
      chat: need(rest(p, 0), 'typing <chat>'),
      typing: !bool(p, 'stop'),
    }),
  },
  group: {
    usage: GROUP_USAGE,
    summary: 'Create or change group chats',
    tool: 'manage_group',
    build: (p) => {
      const [action, a1, ...more] = p.pos;
      const usage = GROUP_USAGE;
      // --confirm means the user approved adding someone outside the allowlist, or leaving the group.
      const user_confirmed = bool(p, 'confirm');
      if (action === 'create')
        return { action: 'create', participants: [need(a1, usage), ...more], title: str(p, 'name'), user_confirmed };
      if (action === 'rename') return { action: 'rename', chat: need(a1, usage), title: need(more.join(' '), usage) };
      if (action === 'add' || action === 'remove')
        return { action, chat: need(a1, usage), person: need(more.join(' '), usage), user_confirmed };
      if (action === 'icon') {
        if (bool(p, 'clear')) return { action: 'set_icon', chat: need(a1, usage), clear_icon: true };
        const path = need(more.join(' '), usage);
        let data: Buffer;
        try {
          data = readFileSync(path);
        } catch {
          throw new CliError(`Can't read ${path}.`, EXIT.usage);
        }
        return { action: 'set_icon', chat: need(a1, usage), image_base64: data.toString('base64') };
      }
      if (action === 'leave') return { action: 'leave', chat: need(a1, usage), user_confirmed };
      throw new CliError(`Usage: imessage ${usage}`, EXIT.usage);
    },
  },
};
