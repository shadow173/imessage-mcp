// What the owner and agent add on top of Messages, kept in the sidecar: aliases, notes and labels on people, labels on
// chats, reminders that dismiss themselves on a reply, and drafts (scheduled or not) with their send state.

import { randomBytes } from 'node:crypto';
import { ToolError } from '../lib/errors.js';
import {
  applyDraftPatch,
  applyPersonPatch,
  draftNotFound,
  draftSend,
  emptyDraftResult,
  newDraft,
  newReminder,
  normLabels,
  requireUnsent,
} from '../store/organizer.js';
import type { MessageStore } from '../store/ports.js';
import {
  type Chat,
  DISMISSED_KEEP_MS,
  type DismissedReminder,
  type DismissWhen,
  type Draft,
  type DraftAttachment,
  type DraftInput,
  type DraftPatch,
  type Person,
  type PersonPatch,
  type Reminder,
  type SendResult,
} from '../store/types.js';
import { toAppleNs } from './appleTime.js';
import type { LiveContext } from './context.js';
import { fromDb, optNum, optStr, REAL, type Row, SQL_MS } from './sql.js';

/** The older dismiss_on_reply column's codes, still written for older bridges sharing the sidecar. */
const DISMISS_CODE: Record<DismissWhen, number> = { never: 0, they_reply: 1, i_reply: 2 };
const DISMISS_FROM_CODE: DismissWhen[] = ['never', 'they_reply', 'i_reply'];
/** dismiss_when, or (for a row an older bridge wrote after the migration) the dismiss_on_reply code. */
const dismissWhenOf = (r: Row): DismissWhen =>
  DISMISS_FROM_CODE.includes(r.dismiss_when as DismissWhen)
    ? (r.dismiss_when as DismissWhen)
    : (DISMISS_FROM_CODE[Number(r.dismiss_on_reply)] ?? 'they_reply');

export interface OrganizerDeps {
  send: MessageStore['send'];
  invalidateSummaries(): void;
  /** This bridge run, recorded on a draft while it sends. */
  bootId: string;
  now(): number;
}

export class Organizer {
  constructor(
    private ctx: LiveContext,
    private deps: OrganizerDeps,
  ) {}

  /** A draft still marked as sending belongs to a bridge that stopped mid-send: never send it again by itself. */
  settleInterruptedSends() {
    this.ctx.side.db
      .prepare(
        "update drafts set status = 'failed', error = 'outcome_unknown', sending_boot = null where sending_boot is not null",
      )
      .run();
  }

  updatePerson(personId: string, p: PersonPatch): Person {
    const person = this.ctx.dir.peopleById.get(personId);
    if (!person) throw new ToolError('person_not_found', `No person has id "${personId}".`);
    applyPersonPatch(person, p);
    this.ctx.side.db
      .prepare(
        'insert into person_meta(person_id, aliases, note, labels) values (?, ?, ?, ?) on conflict(person_id) do update set aliases = excluded.aliases, note = excluded.note, labels = excluded.labels',
      )
      .run(personId, JSON.stringify(person.aliases), person.note ?? null, JSON.stringify(person.labels));
    return person;
  }

  labelChat(chatId: string, add: string[], remove: string[]): Chat {
    const c = this.ctx.dir.chat(chatId);
    if (!c) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    for (const l of normLabels(remove))
      this.ctx.side.db.prepare('delete from chat_labels where chat_id = ? and label = ?').run(c.chatId, l);
    for (const l of normLabels(add))
      this.ctx.side.db.prepare('insert or ignore into chat_labels(chat_id, label) values (?, ?)').run(c.chatId, l);
    c.labels = (
      this.ctx.side.db.prepare('select label from chat_labels where chat_id = ? order by label').all(c.chatId) as Row[]
    ).map((r) => String(r.label));
    this.deps.invalidateSummaries();
    return c;
  }

  labelCounts() {
    return (
      this.ctx.side.db
        .prepare('select label name, count(*) count from chat_labels group by label order by count desc')
        .all() as Row[]
    ).map((r) => ({ name: String(r.name), count: Number(r.count) }));
  }

  setReminder(
    chatId: string,
    remindAt: number | null,
    note: string | undefined,
    dismiss: boolean | DismissWhen,
  ): Reminder | null {
    const c = this.ctx.dir.chat(chatId);
    if (!c) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    this.ctx.side.db.prepare('delete from reminders where chat_id = ?').run(c.chatId);
    if (remindAt === null) return null;
    this.ctx.side.db.prepare('delete from reminder_dismissals where chat_id = ?').run(c.chatId);
    const r = newReminder(
      `r${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      c.chatId,
      remindAt,
      note,
      dismiss,
      Date.now(),
    );
    this.ctx.side.db
      .prepare(
        'insert into reminders(id, chat_id, remind_at, note, dismiss_when, dismiss_on_reply, created_at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.reminderId, r.chatId, r.remindAt, r.note ?? null, r.dismissWhen, DISMISS_CODE[r.dismissWhen], r.createdAt);
    return r;
  }

  reminders(): Reminder[] {
    const rows = this.ctx.side.db.prepare('select * from reminders order by remind_at').all() as Row[];
    const out: Reminder[] = [];
    for (const r of rows) {
      const dismissWhen = dismissWhenOf(r);
      const rem: Reminder = {
        reminderId: String(r.id),
        chatId: String(r.chat_id),
        remindAt: Number(r.remind_at),
        note: optStr(r.note),
        dismissWhen,
        dismissOnReply: dismissWhen === 'they_reply',
        createdAt: Number(r.created_at),
      };
      const chat = this.ctx.dir.chatRec(rem.chatId);
      if (!chat) continue;
      // REAL() leaves out tapbacks and group events, so only an actual message dismisses; it is kept a week as
      // auto-dismissed.
      const by =
        dismissWhen === 'never'
          ? undefined
          : (this.ctx.db
              .prepare(
                `select m.ROWID r, ${SQL_MS('m.date')} ms
                from message m join chat_message_join cmj on cmj.message_id = m.ROWID
                where cmj.chat_id = ? and m.is_from_me = ? and m.date > ? and ${REAL()} order by m.date limit 1`,
              )
              .get(chat.rowid, dismissWhen === 'i_reply' ? 1 : 0, toAppleNs(rem.createdAt)) as
              | { r: number; ms: number }
              | undefined);
      if (by) {
        this.ctx.side.db
          .prepare(
            'insert or replace into reminder_dismissals(id, chat_id, remind_at, note, dismiss_when, dismiss_on_reply, created_at, dismissed_at, dismissed_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            rem.reminderId,
            rem.chatId,
            rem.remindAt,
            rem.note ?? null,
            dismissWhen,
            DISMISS_CODE[dismissWhen],
            rem.createdAt,
            fromDb(by.ms) ?? Date.now(),
            `m${by.r}`,
          );
        this.ctx.side.db.prepare('delete from reminders where id = ?').run(rem.reminderId);
        continue;
      }
      out.push(rem);
    }
    return out;
  }

  dismissedReminders(): DismissedReminder[] {
    this.reminders();
    this.ctx.side.db
      .prepare('delete from reminder_dismissals where dismissed_at < ?')
      .run(Date.now() - DISMISSED_KEEP_MS);
    return (
      this.ctx.side.db.prepare('select * from reminder_dismissals order by dismissed_at desc').all() as Row[]
    ).map((r) => {
      const dismissWhen = dismissWhenOf(r);
      return {
        reminderId: String(r.id),
        chatId: String(r.chat_id),
        remindAt: Number(r.remind_at),
        note: optStr(r.note),
        dismissWhen,
        dismissOnReply: dismissWhen === 'they_reply',
        createdAt: Number(r.created_at),
        dismissedAt: Number(r.dismissed_at),
        ...(r.dismissed_by ? { dismissedBy: String(r.dismissed_by) } : {}),
      };
    });
  }

  createDraft(d: DraftInput): Draft {
    const draft = newDraft(d, `d${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, Date.now());
    this.ctx.side.db
      .prepare(
        'insert into drafts(id, chat_id, to_address, text, send_at, note, status, created_at, confirmed, attempts, reply_to, effect, attachments) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
      )
      .run(
        draft.draftId,
        draft.chatId,
        draft.toAddress ?? null,
        draft.text,
        draft.sendAt ?? null,
        draft.note ?? null,
        draft.status,
        draft.createdAt,
        draft.confirmed ? 1 : 0,
        draft.replyTo ?? null,
        draft.effect ?? null,
        draft.attachments?.length ? JSON.stringify(draft.attachments) : null,
      );
    return draft;
  }

  drafts(): Draft[] {
    return (this.ctx.side.db.prepare('select * from drafts order by created_at desc').all() as Row[]).map((r) => {
      let attachments: DraftAttachment[] | undefined;
      try {
        attachments = r.attachments ? JSON.parse(String(r.attachments)) : undefined;
      } catch {
        /* unreadable row */
      }
      return {
        draftId: String(r.id),
        chatId: optStr(r.chat_id) ?? null,
        toAddress: optStr(r.to_address),
        text: String(r.text),
        attachmentNames: (attachments ?? []).map((x) => x.filename),
        sendAt: optNum(r.send_at),
        note: optStr(r.note),
        status: r.status as Draft['status'],
        createdAt: Number(r.created_at),
        sentMessageId: optStr(r.sent_message_id),
        ...(r.error ? { error: String(r.error) } : {}),
        ...(r.confirmed ? { confirmed: true } : {}),
        attempts: Number(r.attempts ?? 0),
        ...(r.reply_to ? { replyTo: String(r.reply_to) } : {}),
        ...(r.effect ? { effect: String(r.effect) } : {}),
        ...(attachments?.length ? { attachments } : {}),
      };
    });
  }

  private draft(id: string): Draft {
    const d = this.drafts().find((x) => x.draftId === id);
    if (!d) throw draftNotFound(id);
    return d;
  }

  updateDraft(id: string, patch: DraftPatch): Draft {
    const d = this.draft(id);
    requireUnsent(d);
    applyDraftPatch(d, patch, this.deps.now());
    this.ctx.side.db
      .prepare(
        'update drafts set text = ?, send_at = ?, status = ?, note = ?, confirmed = ?, error = ?, sent_message_id = ? where id = ?',
      )
      .run(
        d.text,
        d.sendAt ?? null,
        d.status,
        d.note ?? null,
        d.confirmed ? 1 : 0,
        d.error ?? null,
        d.sentMessageId ?? null,
        d.draftId,
      );
    return d;
  }

  markDraftFailed(id: string, code: string): Draft {
    const d = this.draft(id);
    requireUnsent(d);
    this.ctx.side.db.prepare("update drafts set status = 'failed', error = ? where id = ?").run(code, id);
    return { ...d, status: 'failed', error: code };
  }

  deleteDraft(id: string) {
    this.draft(id);
    this.ctx.side.db.prepare('delete from drafts where id = ?').run(id);
  }

  async sendDraft(id: string): Promise<SendResult> {
    const d = this.draft(id);
    requireUnsent(d);
    const out = draftSend(d);
    if (!d.text.trim() && !out.files.length) {
      this.markDraftFailed(id, 'empty_message');
      return emptyDraftResult(d);
    }
    // Marked before the send, so a restart mid-send turns it into failed:outcome_unknown instead of a second send.
    this.ctx.side.db.prepare('update drafts set sending_boot = ? where id = ?').run(this.deps.bootId, d.draftId);
    let r: SendResult;
    try {
      // ToolErrors (in_progress, idempotency_conflict, ...) propagate with the draft untouched.
      r = await this.deps.send(out.target, d.text, out.files, 'auto', out.key, out.extras);
    } catch (e) {
      this.ctx.side.db.prepare('update drafts set sending_boot = null where id = ?').run(d.draftId);
      throw e;
    }
    if (r.disposition === 'failed')
      this.ctx.side.db
        .prepare(
          "update drafts set status = 'failed', attempts = attempts + 1, error = ?, sent_message_id = null, sending_boot = null where id = ?",
        )
        .run(r.error?.code ?? 'failed', d.draftId);
    else
      this.ctx.side.db
        .prepare(
          "update drafts set status = 'sent', sent_message_id = ?, error = null, sending_boot = null where id = ?",
        )
        .run(r.message?.messageId ?? null, d.draftId);
    return r;
  }
}
