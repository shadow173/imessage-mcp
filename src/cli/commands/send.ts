// Commands that send or keep messages: send_message, create_draft and manage_drafts.

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { bool, need, rest, str } from '../args.js';
import { autoKey } from '../autoKey.js';
import type { Command } from '../command.js';
import { CliError, EXIT } from '../errors.js';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

/** --file paths as send_message attachments (base64). */
function attachmentsFrom(paths: string[] | undefined) {
  return paths?.map((path) => {
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      throw new CliError(`Can't read ${path}.`, EXIT.usage);
    }
    return {
      filename: basename(path),
      mime_type: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      base64: data.toString('base64'),
    };
  });
}

export const SEND_COMMANDS: Record<string, Command> = {
  send: {
    usage:
      'send <to> <text> [--file path ...] [--forward attachment_id ...] [--confirm] [--sms] [--reply-to message_id] [--effect confetti] [--key k]',
    summary: 'Send an iMessage or SMS (the same command in the same clock minute sends once; --key k for safe retries)',
    tool: 'send_message',
    build: (p) => {
      const to = need(p.pos[0], 'send <to> <text>');
      const text = rest(p, 1);
      const files = p.multi.file;
      const forward = p.multi.forward ?? [];
      if (!text && !files?.length && !forward.length)
        throw new CliError('Usage: imessage send <to> <text> [--file path] [--forward attachment_id]', EXIT.usage);
      const attachments = [...(attachmentsFrom(files) ?? []), ...forward.map((id) => ({ attachment_id: id }))];
      return {
        to,
        text: text || undefined,
        attachments: attachments.length ? attachments : undefined,
        service: bool(p, 'sms') ? 'sms' : undefined,
        idempotency_key: str(p, 'key') ?? autoKey(to, text, [...(files ?? []), ...forward]),
        user_confirmed: bool(p, 'confirm'),
        reply_to: str(p, 'reply-to'),
        effect: str(p, 'effect'),
      };
    },
  },
  draft: {
    usage: 'draft <to> <text> [--at "tomorrow 09:00"|2h|2026-10-18T09:00] [--note n] [--confirm]',
    summary: 'Save a draft, or schedule it with --at (a date alone means 09:00)',
    tool: 'create_draft',
    build: (p) => ({
      to: need(p.pos[0], 'draft <to> <text>'),
      text: need(rest(p, 1), 'draft <to> <text>'),
      send_at: str(p, 'at'),
      note: str(p, 'note'),
      user_confirmed: bool(p, 'confirm'),
    }),
  },
  drafts: {
    usage: 'drafts [--status pending|draft|scheduled|sent|failed|all] [--to who]',
    summary: 'List drafts and scheduled messages (default: not yet sent)',
    tool: 'manage_drafts',
    build: (p) => ({ action: 'list', status: str(p, 'status'), to: str(p, 'to') }),
  },
  'draft-update': {
    usage: 'draft-update <draft_id> [--text t] [--at when|none] [--note n] [--confirm]',
    summary: 'Reword, reschedule (--at none unschedules) or annotate a draft',
    tool: 'manage_drafts',
    build: (p) => ({
      action: 'update',
      draft_id: need(p.pos[0], 'draft-update <draft_id>'),
      text: str(p, 'text'),
      send_at: str(p, 'at'),
      note: str(p, 'note'),
      user_confirmed: bool(p, 'confirm'),
    }),
  },
  'draft-send': {
    usage: 'draft-send <draft_id> [--confirm]',
    summary: 'Send a draft now',
    tool: 'manage_drafts',
    build: (p) => ({
      action: 'send_now',
      draft_id: need(p.pos[0], 'draft-send <draft_id>'),
      user_confirmed: bool(p, 'confirm'),
    }),
  },
  'draft-delete': {
    usage: 'draft-delete <draft_id>',
    summary: 'Delete a draft',
    tool: 'manage_drafts',
    build: (p) => ({ action: 'delete', draft_id: need(p.pos[0], 'draft-delete <draft_id>') }),
  },
};
