import type { Tier } from '../config.js';

export const SCOPES = { read: 'messages.read', organize: 'messages.organize', send: 'messages.send' } as const;
export const ALL_SCOPES: string[] = [SCOPES.read, SCOPES.organize, SCOPES.send];

export const TIER_SCOPE: Record<Tier, string> = {
  read: SCOPES.read,
  gpt: SCOPES.read,
  org: SCOPES.organize,
  send: SCOPES.send,
  pa: SCOPES.send,
};

export const SCOPE_INFO: Record<string, { label: string; detail: string; required?: boolean }> = {
  [SCOPES.read]: { label: 'Read', detail: 'Messages, people, attachments', required: true },
  [SCOPES.organize]: { label: 'Organize', detail: 'Labels, aliases, notes, reminders, mark unread' },
  [SCOPES.send]: {
    label: 'Send as you',
    detail: 'Messages, drafts, reactions, edits, read receipts, typing, group changes',
  },
};

export function parseScopes(s: string | undefined): string[] {
  return [...new Set((s ?? '').split(/[\s+]+/).filter((x) => ALL_SCOPES.includes(x)))];
}
