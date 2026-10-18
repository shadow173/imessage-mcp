// Commands that organize: aliases and notes on people, labels and reminders on chats.

import { bool, need, rest, str } from '../args.js';
import type { Command } from '../command.js';

export const ORGANIZE_COMMANDS: Record<string, Command> = {
  alias: {
    usage: 'alias <person> <alias> [--confirm]',
    summary: 'Remember another name for someone ("my landlord"); --confirm saves one that already matches someone else',
    tool: 'update_person',
    build: (p) => ({
      person: need(p.pos[0], 'alias <person> <alias>'),
      add_aliases: [need(rest(p, 1), 'alias <person> <alias>')],
      user_confirmed: bool(p, 'confirm'),
    }),
  },
  note: {
    usage: 'note <person> <text>',
    summary: 'Save a note about someone',
    tool: 'update_person',
    build: (p) => ({ person: need(p.pos[0], 'note <person> <text>'), note: rest(p, 1) }),
  },
  label: {
    usage: 'label [<chat> <label>... [--remove]]',
    summary: 'Label a chat, or list labels',
    tool: 'label_conversation',
    build: (p) =>
      p.pos.length
        ? { chat: p.pos[0], ...(bool(p, 'remove') ? { remove: p.pos.slice(1) } : { add: p.pos.slice(1) }) }
        : {},
  },
  remind: {
    usage: 'remind [<chat> <when> [--note text] [--dismiss-when i_reply|they_reply|never] | <chat> --clear]',
    summary: 'Reminder about a chat (shows in catchup; nothing is pushed to the phone); no arguments lists reminders',
    tool: 'set_reminder',
    build: (p) => {
      if (!p.pos.length) return {};
      const chat = p.pos[0];
      if (bool(p, 'clear')) return { chat, clear: true };
      return {
        chat,
        remind_at: need(p.pos.slice(1).join(' ') || undefined, 'remind <chat> <when>'),
        note: str(p, 'note'),
        dismiss_when: str(p, 'dismiss-when'),
      };
    },
  },
};
