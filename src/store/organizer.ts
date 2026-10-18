// The organizer's rules, shared by both stores: how aliases and labels merge, what a new reminder or draft looks like,
// how a draft's status moves, and what sending one passes on. Each store keeps the data its own way (in memory, or in
// the sidecar).

import { dmChatGuid } from '../domain/chatGuid.js';
import { normLabel } from '../domain/naming.js';
import { ToolError } from '../lib/errors.js';
import type {
  DismissWhen,
  Draft,
  DraftInput,
  DraftPatch,
  OutgoingAttachment,
  Person,
  PersonPatch,
  Reminder,
  SendExtras,
  SendResult,
} from './types.js';

/** Applies update_person's changes to person, in place: aliases merge case-insensitively, labels are normalized. */
export function applyPersonPatch(person: Person, p: PersonPatch): Person {
  const clean = (xs?: string[]) => (xs ?? []).map((x) => x.trim()).filter(Boolean);
  const rmAliases = new Set(clean(p.removeAliases).map((x) => x.toLowerCase()));
  const aliases: string[] = [];
  for (const x of [...person.aliases.filter((y) => !rmAliases.has(y.toLowerCase())), ...clean(p.addAliases)])
    if (!aliases.some((y) => y.toLowerCase() === x.toLowerCase())) aliases.push(x);
  person.aliases = aliases;
  const rmLabels = new Set(clean(p.removeLabels).map(normLabel));
  person.labels = [
    ...new Set([
      ...person.labels.map(normLabel).filter((l) => l && !rmLabels.has(l)),
      ...clean(p.addLabels).map(normLabel).filter(Boolean),
    ]),
  ];
  if (p.note !== undefined) person.note = p.note || undefined;
  return person;
}

/** Labels as label_conversation stores them: normalized, empty ones dropped. */
export const normLabels = (xs: string[]) => xs.map(normLabel).filter(Boolean);

/** The older boolean form of dismiss (true = they_reply, false = never) as a DismissWhen. */
export const toDismissWhen = (d: boolean | DismissWhen): DismissWhen =>
  typeof d === 'boolean' ? (d ? 'they_reply' : 'never') : d;

export function newReminder(
  reminderId: string,
  chatId: string,
  remindAt: number,
  note: string | undefined,
  dismiss: boolean | DismissWhen,
  createdAt: number,
): Reminder {
  const dismissWhen = toDismissWhen(dismiss);
  return { reminderId, chatId, remindAt, note, dismissWhen, dismissOnReply: dismissWhen === 'they_reply', createdAt };
}

/** A new draft: scheduled when it has a send time, with its file names listed even when only the files were given. */
export function newDraft(d: DraftInput, draftId: string, createdAt: number): Draft {
  const attachmentNames = d.attachmentNames?.length ? d.attachmentNames : (d.attachments ?? []).map((x) => x.filename);
  return { ...d, attachmentNames, draftId, status: d.sendAt ? 'scheduled' : 'draft', createdAt, attempts: 0 };
}

export function draftNotFound(id: string): ToolError {
  return new ToolError(
    'draft_not_found',
    `No draft has id "${id}".`,
    'Call manage_drafts with action=list to see draft ids.',
  );
}

export function alreadySentError(d: Draft): ToolError {
  return new ToolError(
    'already_sent',
    d.sentMessageId ? `That draft was already sent as #${d.sentMessageId}.` : 'That draft was already sent.',
    'Do not send it again. To change it, use edit_message or unsend_message on that id.',
  );
}

/** A sent draft is final: it can't be changed, marked failed or sent again. */
export function requireUnsent(d: Draft): void {
  if (d.status === 'sent') throw alreadySentError(d);
}

/** Applies manage_drafts update to d, in place. Call requireUnsent first. */
export function applyDraftPatch(d: Draft, patch: DraftPatch, now: number): Draft {
  const wasFailed = d.status === 'failed';
  if (patch.text !== undefined) d.text = patch.text;
  if (patch.note !== undefined) d.note = patch.note || undefined;
  if (patch.confirmed !== undefined) d.confirmed = patch.confirmed;
  if (patch.sendAt !== undefined) d.sendAt = patch.sendAt ?? undefined;
  // A failed draft becomes sendable again; an overdue send time leaves it as a plain draft.
  if (wasFailed || patch.sendAt !== undefined) d.status = d.sendAt && d.sendAt > now ? 'scheduled' : 'draft';
  if (wasFailed) {
    delete d.sentMessageId;
    delete d.error;
  }
  return d;
}

/**
 * What sending a draft passes to send(): its recipient, files, reply and effect, and a key with the attempt count in
 * it, so a retry after a failure really sends again.
 */
export function draftSend(d: Draft): {
  target: { chatId?: string; address?: string };
  files: OutgoingAttachment[];
  extras: SendExtras;
  key: string;
} {
  return {
    target: d.chatId ? { chatId: d.chatId } : { address: d.toAddress },
    files: (d.attachments ?? []).map((x) => ({
      filename: x.filename,
      mime: x.mime,
      ...(x.url ? { url: x.url } : {}),
      ...(x.sourceAttachmentId ? { sourceAttachmentId: x.sourceAttachmentId } : {}),
    })),
    extras: {
      ...(d.replyTo ? { replyTo: d.replyTo } : {}),
      ...(d.effect ? { effect: d.effect } : {}),
    },
    key: `draft:${d.draftId}:${d.attempts ?? 0}`,
  };
}

/** A draft with no text and no files: nothing is sent, and the draft is marked failed with empty_message. */
export function emptyDraftResult(d: Draft): SendResult {
  return {
    disposition: 'failed',
    chatId: d.chatId ?? dmChatGuid(d.toAddress ?? ''),
    retrySafe: false,
    error: {
      code: 'empty_message',
      message: `Draft ${d.draftId} has no text and no files, so nothing was sent.`,
      fix: 'Add text with manage_drafts action=update, then send it again.',
    },
  };
}
