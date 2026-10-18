import { randomUUID } from 'node:crypto';
import { chatGuidIdentifier, dmChatGuid } from '../domain/chatGuid.js';
import { effectLabel } from '../domain/effects.js';
import { chatTitle, isUnknownSender, personDisplayName } from '../domain/naming.js';
import { isShortCodePerson, needsReply } from '../domain/needsReply.js';
import { isShortCode, normalizeAddress } from '../lib/address.js';
import { ToolError } from '../lib/errors.js';
import { localParts } from '../lib/time.js';
import { DAY_MS } from '../lib/units.js';
import { redact } from '../policy/redact.js';
import { type EventExtra, EventLog } from '../store/eventLog.js';
import { idempotencyConflict, sendFingerprint } from '../store/idempotency.js';
import { hostMatches, linkHost, normDomain, queryTerms, termHits, textTerms, wordTokens } from '../store/match.js';
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
import { groupStats } from '../store/stats.js';
import {
  type Attachment,
  type AttachmentFilter,
  type Chat,
  type ChatActivity,
  type ChatPage,
  type ChatSummary,
  DISMISSED_KEEP_MS,
  type DismissedReminder,
  type DismissWhen,
  type Draft,
  type DraftInput,
  type DraftPatch,
  type GroupAction,
  type ListPage,
  type ManageGroupArgs,
  ME,
  type Message,
  type MessageFilter,
  type MsgKey,
  type OutgoingAttachment,
  type Person,
  type PersonActivity,
  type PersonPatch,
  type Reaction,
  type ReactionKind,
  type Reminder,
  type SendAttachmentResult,
  type SendExtras,
  type SendResult,
  type Service,
  type StatGroup,
  type StatMetric,
  type StatRow,
  type UpdateEvent,
} from '../store/types.js';
import { buildSeed } from './seed.js';

export { queryTerms };

const AUTO_REPLIES = [
  '👍',
  'sounds good!',
  'haha yes',
  'ok perfect',
  'on it',
  'lol',
  'thanks!',
  'can I call you later?',
];

export interface MockStoreOptions {
  timeZone: string;
  /** Pins the store's start (and the seed) to this time; the clock then advances in real time from it. */
  now?: number;
  /** Replaces the clock entirely, e.g. `() => fixed` for a frozen one. The seed anchors to `now`, else to `clock()`. */
  clock?: () => number;
  autoReply?: boolean;
  redactCodes?: boolean;
}

export class MockStore implements MessageStore {
  readonly mode = 'mock' as const;
  readonly timeZone: string;
  readonly bootId = randomUUID().slice(0, 8);
  private _people = new Map<string, Person>();
  private _chats = new Map<string, Chat>();
  private _messages: Message[] = [];
  private _byId = new Map<string, Message>();
  private _attachments = new Map<string, Attachment>();
  private _me: { name: string; handles: string[] };
  private _log = new EventLog(() => this.now());
  private _idem = new Map<string, { result: SendResult; fp: string }>();
  private _drafts = new Map<string, Draft>();
  private _reminders = new Map<string, Reminder>();
  private _dismissed = new Map<string, DismissedReminder>();
  private _nextMsg = 900000;
  private _nextId = 1;
  readonly startedAt: number;
  private readonly clock: () => number;
  autoReply: boolean;
  /** Hides one-time codes from the search haystack, like the live index. */
  readonly redactCodes: boolean;

  constructor(opts: MockStoreOptions) {
    this.timeZone = opts.timeZone;
    const pinned = opts.now;
    const bootReal = Date.now();
    this.clock = opts.clock ?? (pinned === undefined ? Date.now : () => pinned + (Date.now() - bootReal));
    this.startedAt = pinned ?? this.clock();
    this.autoReply = opts.autoReply ?? true;
    this.redactCodes = opts.redactCodes ?? true;
    const seed = buildSeed(this.startedAt, this.timeZone);
    for (const p of seed.people) this._people.set(p.personId, p);
    for (const c of seed.chats) this._chats.set(c.chatId, c);
    for (const a of seed.attachments) this._attachments.set(a.attachmentId, a);
    this._messages = seed.messages;
    for (const m of this._messages) this._byId.set(m.messageId, m);
    this._me = seed.me;
  }

  now(): number {
    return this.clock();
  }
  me() {
    return this._me;
  }
  people(): Person[] {
    return [...this._people.values()];
  }
  person(id: string) {
    return this._people.get(id);
  }
  chats(): Chat[] {
    return [...this._chats.values()];
  }
  chat(id: string) {
    return this._chats.get(id);
  }
  message(id: string) {
    return this._byId.get(id);
  }
  attachment(id: string) {
    return this._attachments.get(id);
  }
  // No files on disk: get_attachment shows a seeded image's own data, extracted text is on the attachment itself, and
  // the gateway's mock mode serves /files from the seed (backend.ts).
  async attachmentPreview(): Promise<null> {
    return null;
  }
  async attachmentText(): Promise<null> {
    return null;
  }
  async attachmentFile(): Promise<null> {
    return null;
  }
  private attachments(): Attachment[] {
    return [...this._attachments.values()].sort((a, b) => b.sentAt - a.sentAt);
  }

  /** An id with no person is shown as itself (the live store says "Unknown"). */
  personName(id: string): string {
    return personDisplayName(id, this._people.get(id), id);
  }

  chatTitle(c: Chat): string {
    return chatTitle(this, c);
  }

  private chatMessages(chatId: string): Message[] {
    return this._messages.filter((m) => m.chatId === chatId);
  }

  summarizeChat(chatId: string): ChatSummary {
    const chat = this._chats.get(chatId);
    if (!chat) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    const msgs = this.chatMessages(chatId);
    const real = msgs.filter((m) => !m.system);
    const last = real[real.length - 1];
    const other = chat.type === 'dm' ? this._people.get(chat.participantIds[0]) : undefined;
    return {
      chat,
      title: this.chatTitle(chat),
      lastMessage: last,
      messageCount: real.length,
      unreadCount: real.filter((m) => m.senderId !== ME && !m.isRead && !m.unsent).length,
      // reactions holds only the tapbacks that stand, so an owner's one there acknowledges the message.
      needsReply:
        !!last &&
        needsReply({
          fromOwner: last.senderId === ME,
          ageMs: this.now() - last.sentAt,
          shortCode: isShortCodePerson(other),
          ownerTapback: last.reactions.some((r) => r.by === ME),
        }),
      unknownSender: isUnknownSender(chat, other),
    };
  }

  private queryMessages(f: MessageFilter, match: 'all' | 'any' = 'all'): Message[] {
    let chatIds: Set<string> | undefined = f.chatIds ? new Set(f.chatIds) : undefined;
    if (f.withPersonId) {
      const withChats = this.chats()
        .filter((c) => c.participantIds.includes(f.withPersonId!))
        .map((c) => c.chatId);
      chatIds = new Set(chatIds ? withChats.filter((id) => chatIds!.has(id)) : withChats);
    }
    const terms = f.text ? textTerms(f.text, match === 'any') : [];
    const linkTerms = f.linkQuery ? queryTerms(f.linkQuery) : [];
    const domain = f.linkDomain ? normDomain(f.linkDomain) : '';
    return this._messages.filter((m) => {
      if (chatIds && !chatIds.has(m.chatId)) return false;
      if (!f.includeSystem && m.system) return false;
      if (f.after !== undefined && m.sentAt < f.after) return false;
      if (f.before !== undefined && m.sentAt >= f.before) return false;
      if (f.from) {
        if (f.from.kind === 'me' && m.senderId !== ME) return false;
        if (f.from.kind === 'others' && m.senderId === ME) return false;
        if (f.from.kind === 'person' && m.senderId !== f.from.personId) return false;
      }
      if (f.chatType || f.service) {
        const c = this._chats.get(m.chatId)!;
        if (f.chatType && c.type !== f.chatType) return false;
        if (f.service && c.service !== f.service) return false;
      }
      if (f.hasAttachment !== undefined && m.attachmentIds.length > 0 !== f.hasAttachment) return false;
      if (
        f.attachmentKinds?.length &&
        !m.attachmentIds.some((id) => f.attachmentKinds!.includes(this._attachments.get(id)!.kind))
      )
        return false;
      if (f.hasLink !== undefined && !!m.link !== f.hasLink) return false;
      if (linkTerms.length) {
        const hay = m.link ? this.hide(`${m.link.title} ${m.link.url}`, m).toLowerCase() : '';
        if (!hay || !linkTerms.every((t) => hay.includes(t))) return false;
      }
      if (domain && !(m.link && hostMatches(linkHost(m.link.url, m.link.site), domain))) return false;
      if (f.unreadOnly && (m.senderId === ME || m.isRead)) return false;
      if (terms.length) {
        if (m.unsent) return false;
        const hay = this.haystack(m);
        if (match === 'any' ? !terms.some((t) => termHits(hay, t)) : !terms.every((t) => termHits(hay, t)))
          return false;
      }
      return true;
    });
  }

  /** Text with one-time codes dropped, as the live index stores it. */
  private hide(text: string, m: Message): string {
    return redact(
      text,
      m.senderId === ME ? undefined : this._people.get(m.senderId)?.handles[0]?.address,
      this.redactCodes,
      { replacement: ' ' },
    );
  }

  /** What the live index holds for a message: its text and link title with codes removed, app name and file names. */
  private haystack(m: Message): string[] {
    const parts = [
      this.hide(m.text, m),
      this.hide(m.link?.title ?? '', m),
      m.appType ?? '',
      ...m.attachmentIds.map((id) => this._attachments.get(id)?.name ?? ''),
    ];
    return wordTokens(parts.join(' '));
  }

  private searchMessages(
    f: MessageFilter & { text: string },
    match: 'all' | 'any',
  ): { message: Message; score: number }[] {
    const terms = textTerms(f.text, match === 'any');
    const now = this.now();
    return this.queryMessages(f, match)
      .map((message) => {
        const hay = this.haystack(message);
        let score = 0;
        for (const t of terms) {
          const n = termHits(hay, t);
          score += match === 'any' ? (n ? 2 + Math.min(n, 4) * 0.25 : 0) : n;
        }
        score += Math.max(0, 1 - (now - message.sentAt) / (365 * DAY_MS)) * (match === 'any' ? 0.5 : 1); // gentle recency boost
        return { message, score };
      })
      .sort((a, b) => b.score - a.score || b.message.sentAt - a.message.sentAt);
  }

  chatSummaries(): ChatSummary[] {
    return this.chats().map((c) => this.summarizeChat(c.chatId));
  }

  pageChat(
    chatId: string,
    filter: MessageFilter,
    o: { limit: number; before?: MsgKey; after?: MsgKey; anchor: 'start' | 'end' },
  ): ChatPage {
    const all = this.queryMessages({ ...filter, chatIds: [chatId] });
    const num = (id: string) => Number(id.replace(/\D/g, '')) || 0;
    const cmp = (m: Message, k: MsgKey) => m.sentAt - k.t || num(m.messageId) - num(k.id);
    let start: number;
    let end: number;
    if (o.before) {
      end = all.findIndex((m) => cmp(m, o.before!) >= 0);
      if (end < 0) end = all.length;
      start = Math.max(0, end - o.limit);
    } else if (o.after) {
      start = all.findIndex((m) => cmp(m, o.after!) > 0);
      if (start < 0) start = all.length;
      end = Math.min(all.length, start + o.limit);
    } else if (o.anchor === 'start') {
      start = 0;
      end = Math.min(all.length, o.limit);
    } else {
      end = all.length;
      start = Math.max(0, end - o.limit);
    }
    return { items: all.slice(start, end), hasOlder: start > 0, hasNewer: end < all.length, total: all.length };
  }

  listMessages(filter: MessageFilter, o: { order: 'asc' | 'desc'; limit: number; offset: number }): ListPage {
    const all = this.queryMessages(filter);
    if (o.order === 'desc') all.reverse();
    return { items: all.slice(o.offset, o.offset + o.limit), total: all.length };
  }

  search(
    filter: MessageFilter & { text: string },
    o: { sort: 'relevance' | 'newest' | 'oldest'; limit: number; offset: number; match?: 'all' | 'any' },
  ): ListPage {
    let hits = this.searchMessages(filter, o.match ?? 'all').map((h) => h.message);
    if (o.sort !== 'relevance')
      hits = hits.sort((x, y) => (o.sort === 'newest' ? y.sentAt - x.sentAt : x.sentAt - y.sentAt));
    return { items: hits.slice(o.offset, o.offset + o.limit), total: hits.length };
  }

  messagesAround(messageId: string, before: number, after: number, includeSystem = true): Message[] {
    const m = this._byId.get(messageId);
    if (!m) return [];
    const all = this.queryMessages({ chatIds: [m.chatId], includeSystem });
    const idx = all.findIndex((x) => x.messageId === messageId);
    return all.slice(Math.max(0, idx - before), idx + after + 1);
  }

  personActivity(personId: string): PersonActivity {
    const dmChatIds = this.chats()
      .filter((c) => c.type === 'dm' && c.participantIds[0] === personId)
      .map((c) => c.chatId);
    const dmSet = new Set(dmChatIds);
    const groupChatIds = this.chats()
      .filter((c) => c.type === 'group' && c.participantIds.includes(personId))
      .map((c) => c.chatId);
    const msgs = this._messages.filter((m) => !m.system && (dmSet.has(m.chatId) || m.senderId === personId));
    const byMonth: Record<string, number> = {};
    let you = 0,
      them = 0,
      lastDay = '',
      dmMessageCount = 0,
      sentByThemInGroups = 0;
    let lastFromMe: Message | undefined, lastFromThem: Message | undefined;
    for (const m of msgs) {
      const lp = localParts(m.sentAt, this.timeZone);
      const k = `${lp.y}-${String(lp.mo).padStart(2, '0')}`;
      byMonth[k] = (byMonth[k] ?? 0) + 1;
      const dm = dmSet.has(m.chatId);
      if (dm) {
        dmMessageCount++;
        const day = `${lp.y}-${lp.mo}-${lp.d}`;
        if (day !== lastDay) {
          lastDay = day;
          if (m.senderId === ME) you++;
          else them++;
        }
      } else if (m.senderId === personId) sentByThemInGroups++;
      if (m.senderId === ME && dm) lastFromMe = m;
      if (m.senderId === personId) lastFromThem = m;
    }
    return {
      messageCount: msgs.length,
      sentByMe: msgs.filter((m) => m.senderId === ME).length,
      sentByThem: msgs.filter((m) => m.senderId === personId).length,
      firstAt: msgs[0]?.sentAt,
      last: msgs[msgs.length - 1],
      dmChatIds,
      groupChatIds,
      byMonth,
      daysStarted: { you, them },
      dmMessageCount,
      sentByThemInGroups,
      lastFromMe,
      lastFromThem,
    };
  }

  chatActivity(chatId: string): ChatActivity {
    const msgs = this.queryMessages({ chatIds: [chatId], includeSystem: true });
    const real = msgs.filter((m) => !m.system);
    const bySender: Record<string, number> = {};
    for (const m of real) bySender[m.senderId] = (bySender[m.senderId] ?? 0) + 1;
    const cutoff = this.now() - 30 * DAY_MS;
    return {
      total: real.length,
      firstAt: real[0]?.sentAt,
      bySender,
      last30Days: real.filter((m) => m.sentAt >= cutoff).length,
      attachments: real.reduce((n, m) => n + m.attachmentIds.length, 0),
      links: real.filter((m) => m.link).length,
      groupEvents: msgs.filter((m) => m.system),
    };
  }

  stats(groupBy: StatGroup, metric: StatMetric, filter: MessageFilter): StatRow[] {
    // An explicit from wins over the one the metric implies.
    const from: MessageFilter['from'] =
      filter.from ?? (metric === 'sent' ? { kind: 'me' } : metric === 'received' ? { kind: 'others' } : undefined);
    const f: MessageFilter = {
      ...filter,
      ...(from ? { from } : {}),
      ...(metric === 'attachments' ? { hasAttachment: true } : {}),
    };
    const rows = this.queryMessages(f).map((m) => {
      const c = this._chats.get(m.chatId)!;
      return {
        senderId: m.senderId,
        chatId: m.chatId,
        chatType: c.type,
        dmPartner: c.type === 'dm' ? c.participantIds[0] : undefined,
        sentAt: m.sentAt,
      };
    });
    return groupStats(
      rows,
      groupBy,
      this.timeZone,
      (id) => this.personName(id),
      (id) => this.chatTitle(this._chats.get(id)!),
    );
  }

  counts() {
    return {
      people: this._people.size,
      chats: this._chats.size,
      messages: this._messages.filter((m) => !m.system).length,
    };
  }

  listAttachments(f: AttachmentFilter, o: { limit: number; offset: number }): ListPage<Attachment> {
    const nameTerms = f.nameQuery ? queryTerms(f.nameQuery) : [];
    const list = this.attachments().filter((x) => {
      if (f.chatId && x.chatId !== f.chatId) return false;
      if (f.from?.kind === 'me' && x.senderId !== ME) return false;
      if (f.from?.kind === 'others' && x.senderId === ME) return false;
      if (f.from?.kind === 'person' && x.senderId !== f.from.personId) return false;
      if (f.kinds?.length && !f.kinds.includes(x.kind)) return false;
      if (nameTerms.length && !nameTerms.every((t) => x.name.toLowerCase().includes(t))) return false;
      if (f.after !== undefined && x.sentAt < f.after) return false;
      if (f.before !== undefined && x.sentAt >= f.before) return false;
      return !this._byId.get(x.messageId)?.unsent;
    });
    return { items: list.slice(o.offset, o.offset + o.limit), total: list.length };
  }

  threadReplies(originatorId: string): Message[] {
    return this._messages.filter((m) => m.replyToId === originatorId);
  }

  // ---------- updates feed
  private emit(type: UpdateEvent['type'], m: Message, extra: EventExtra = {}) {
    this._log.emit(type, m.messageId, m.chatId, extra);
  }
  updatesSince(seq: number): UpdateEvent[] {
    return this._log.updatesSince(seq);
  }
  latestSeq(): number {
    return this._log.latestSeq();
  }
  oldestSeq(): number {
    return this._log.oldestSeq();
  }
  waitForUpdate(afterSeq: number, timeoutMs: number): Promise<void> {
    return this._log.waitForUpdate(afterSeq, timeoutMs);
  }

  private insert(m: Message) {
    this._messages.push(m);
    this._byId.set(m.messageId, m);
  }

  /** The handle an inbound message in this chat comes from. */
  private addressFor(chat: Chat, senderId: string): string | undefined {
    if (senderId === ME) return undefined;
    return chat.type === 'dm' ? chatGuidIdentifier(chat.chatId) : this._people.get(senderId)?.handles[0]?.address;
  }

  /** The person who owns an address, or a new unknown person for it (like Messages does on a first send). */
  private personFor(address: string): Person {
    const addr = normalizeAddress(address);
    if (!addr)
      throw new ToolError(
        'invalid_recipient',
        `"${address}" is not a phone number or email.`,
        'Pass a full phone number (with area code) or an email address.',
      );
    let p = this.people().find((x) => x.handles.some((h) => h.address === addr));
    if (!p) {
      p = {
        personId: `p_${addr.replace(/\W/g, '')}`,
        name: null,
        nicknames: [],
        aliases: [],
        labels: [],
        handles: [{ address: addr, services: [isShortCode(addr) ? 'SMS' : 'iMessage'] }],
      };
      this._people.set(p.personId, p);
    }
    return p;
  }

  /** The existing or new 1:1 thread with an address on a service ('auto': the address's own service). */
  private dmFor(address: string, service: Service | 'auto'): Chat {
    const p = this.personFor(address);
    const addr = normalizeAddress(address)!;
    const svc: Service =
      service !== 'auto'
        ? service
        : isShortCode(addr)
          ? 'SMS'
          : (p.handles.find((h) => h.address === addr)?.services[0] ?? 'iMessage');
    const chatId = dmChatGuid(addr, svc);
    const chat = this._chats.get(chatId) ?? {
      chatId,
      type: 'dm' as const,
      service: svc,
      participantIds: [p.personId],
      displayName: null,
      createdAt: this.now(),
      labels: [],
    };
    this._chats.set(chatId, chat);
    return chat;
  }

  // ---------- sending (AppleScript in live mode)
  idempotencyLookup(key: string): { result: SendResult; fp: string } | undefined {
    const prior = this._idem.get(key);
    return prior ? { result: { ...prior.result }, fp: prior.fp } : undefined;
  }

  async send(
    target: { chatId?: string; address?: string },
    text: string,
    outgoing: OutgoingAttachment[],
    service: Service | 'auto',
    idempotencyKey: string,
    extras: SendExtras = {},
  ): Promise<SendResult> {
    const fp = sendFingerprint(this, target, text, outgoing, extras);
    const prior = this._idem.get(idempotencyKey);
    if (prior) {
      if (prior.fp !== fp)
        throw idempotencyConflict(this, {
          disposition: prior.result.disposition,
          chatId: prior.result.chatId,
          messageId: prior.result.message?.messageId,
        });
      return { ...prior.result, replayed: true };
    }
    for (const o of outgoing) {
      if (o.sourceAttachmentId && !this._attachments.has(o.sourceAttachmentId))
        throw new ToolError(
          'attachment_not_found',
          `No attachment has id "${o.sourceAttachmentId}".`,
          'Use list_attachments or get_message to find attachment ids.',
        );
    }
    let chat: Chat | undefined = target.chatId ? this._chats.get(target.chatId) : undefined;
    if (!chat && target.address) chat = this.dmFor(target.address, service);
    // An explicit service on a 1:1 picks that service's thread with the same address; groups keep their own.
    else if (chat?.type === 'dm' && service !== 'auto' && service !== chat.service)
      chat = this.dmFor(chatGuidIdentifier(chat.chatId), service);
    if (!chat) throw new ToolError('chat_not_found', 'No conversation to send to.');
    const failing = chat.chatId.endsWith('0000');
    const now = this.now();
    // Mock: a file URL containing "fail" doesn't go out, so journeys can exercise partial sends.
    const urlFails = (o: OutgoingAttachment) => !failing && !!o.url?.includes('fail');
    const going = outgoing.filter((o) => !urlFails(o));
    const lost = outgoing.filter(urlFails);
    let m: Message | undefined;
    if (failing || text.trim() || going.length) {
      m = {
        messageId: `m${this._nextMsg++}`,
        chatId: chat.chatId,
        senderId: ME,
        service: chat.service,
        sentAt: now,
        text,
        isRead: true,
        reactions: [],
        attachmentIds: [],
        status: failing ? 'failed' : 'delivered',
        ...(failing ? { error: 'not_delivered' } : { deliveredAt: now + 800 }),
        ...(extras.replyTo ? { replyToId: extras.replyTo.replace(/^#/, '') } : {}),
        ...(extras.effect ? { effect: effectLabel(extras.effect) ?? extras.effect } : {}),
      };
      for (const o of going) {
        const src = o.sourceAttachmentId ? this._attachments.get(o.sourceAttachmentId) : undefined;
        const base = {
          attachmentId: `a${9000 + this._nextId++}`,
          messageId: m.messageId,
          chatId: chat.chatId,
          senderId: ME,
          sentAt: now,
          name: o.filename || src?.name || 'attachment',
        };
        let a: Attachment;
        if (src) {
          a = {
            ...base,
            mime: src.mime,
            bytes: src.bytes,
            kind: src.kind,
            ...(src.width ? { width: src.width, height: src.height } : {}),
            ...(src.durationS ? { durationS: src.durationS } : {}),
            ...(src.dataBase64 ? { dataBase64: src.dataBase64 } : {}),
            ...(src.extractedText ? { extractedText: src.extractedText } : {}),
          };
        } else {
          const bytes = o.base64 ? Math.floor((o.base64.length * 3) / 4) : 250_000;
          const kind = o.mime.startsWith('image/')
            ? 'image'
            : o.mime.startsWith('video/')
              ? 'video'
              : o.mime.startsWith('audio/')
                ? 'audio'
                : o.mime === 'application/pdf'
                  ? 'pdf'
                  : 'document';
          a = {
            ...base,
            mime: o.mime,
            bytes,
            kind,
            ...(o.base64 && kind === 'image' && o.mime === 'image/png' ? { dataBase64: o.base64 } : {}),
          };
        }
        this._attachments.set(a.attachmentId, a);
        m.attachmentIds.push(a.attachmentId);
      }
      m.partCount = Math.max(1, m.attachmentIds.length + (text.trim() ? 1 : 0));
      this.insert(m);
      this.emit('new', m, { actorId: ME });
    }
    const files: SendAttachmentResult[] = outgoing.map((o) =>
      urlFails(o)
        ? { filename: o.filename, messageId: null, status: 'failed', error: 'attachment_failed' }
        : {
            filename: o.filename,
            messageId: m!.messageId,
            status: failing ? 'failed' : 'delivered',
            ...(failing ? { error: 'not_delivered' } : {}),
          },
    );
    const lostNames = lost.map((o) => o.filename).join(', ');
    const result: SendResult = failing
      ? {
          disposition: 'failed',
          message: m,
          chatId: chat.chatId,
          error: {
            code: 'not_delivered',
            message: 'Messages reported the message as not delivered (mock: addresses ending in 0000 always fail).',
          },
          retrySafe: true,
        }
      : !m
        ? {
            disposition: 'failed',
            chatId: chat.chatId,
            error: {
              code: 'attachment_failed',
              message: `${lostNames} could not be sent, so nothing went out.`,
              fix: 'Check the file URL, then try again.',
            },
            retrySafe: true,
          }
        : lost.length
          ? {
              disposition: 'may_have_completed',
              message: m,
              chatId: chat.chatId,
              retrySafe: false,
              error: {
                code: 'attachment_failed',
                message: `${text.trim() ? 'The text was sent' : 'Some files were sent'}, but ${lostNames} failed.`,
                fix: "Don't resend the whole message. Check read_conversation, then send only the missing file with a new idempotency_key.",
              },
            }
          : { disposition: 'delivered', message: m, chatId: chat.chatId, retrySafe: false };
    if (outgoing.length) result.attachments = files;
    // A failure that is safe to retry is not remembered, so a retry with the same key really retries.
    if (!(result.disposition === 'failed' && result.retrySafe)) this._idem.set(idempotencyKey, { result, fp });
    if (!failing && m) this.simulateReply(chat, m);
    return result;
  }

  /** Test/demo hook: an inbound message arrives from a participant. */
  receive(chatId: string, senderId: string, text: string): Message {
    const chat = this._chats.get(chatId);
    if (!chat) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    const addr = this.addressFor(chat, senderId);
    const m: Message = {
      messageId: `m${this._nextMsg++}`,
      chatId,
      senderId,
      ...(addr ? { senderAddress: addr } : {}),
      service: chat.service,
      sentAt: this.now(),
      text,
      isRead: false,
      reactions: [],
      attachmentIds: [],
      partCount: 1,
    };
    this.insert(m);
    this.emit('new', m, { actorId: senderId });
    return m;
  }

  private simulateReply(chat: Chat, mine: Message) {
    if (!this.autoReply) return;
    const responders = chat.participantIds.filter((id) => this._people.get(id)?.name);
    if (!responders.length) return;
    const t1 = setTimeout(
      () => {
        if (chat.type === 'dm' && chat.service === 'iMessage') {
          mine.status = 'read';
          mine.readAt = this.now();
          this.emit('read', mine, { actorId: chat.participantIds[0] });
        }
        const who = responders[Math.floor(Math.random() * responders.length)];
        const addr = this.addressFor(chat, who);
        const reply: Message = {
          messageId: `m${this._nextMsg++}`,
          chatId: chat.chatId,
          senderId: who,
          ...(addr ? { senderAddress: addr } : {}),
          service: chat.service,
          sentAt: this.now(),
          text: AUTO_REPLIES[Math.floor(Math.random() * AUTO_REPLIES.length)],
          isRead: false,
          reactions: [],
          attachmentIds: [],
          partCount: 1,
        };
        this.insert(reply);
        this.emit('new', reply, { actorId: who });
      },
      15_000 + Math.random() * 15_000,
    );
    t1.unref();
  }

  // ---------- private API (needs SIP off in live mode)
  private own(messageId: string): Message {
    const m = this._byId.get(messageId);
    if (!m) throw new ToolError('message_not_found', `No message has id "${messageId}".`);
    return m;
  }
  async setTyping(chatId: string): Promise<void> {
    if (!this._chats.has(chatId)) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
  }
  async react(
    messageId: string,
    kind: ReactionKind,
    emoji: string | undefined,
    remove: boolean,
    part = 0,
  ): Promise<Message> {
    const m = this.own(messageId);
    const mineOnPart = (r: Reaction) => r.by === ME && (r.part ?? 0) === part;
    const before = m.reactions.length;
    if (remove)
      m.reactions = m.reactions.filter(
        (r) => !(mineOnPart(r) && r.kind === kind && (kind !== 'emoji' || !emoji || r.emoji === emoji)),
      );
    else
      m.reactions = [
        ...m.reactions.filter((r) => !mineOnPart(r)),
        { kind, by: ME, at: this.now(), ...(emoji ? { emoji } : {}), ...(part ? { part } : {}) },
      ];
    if (!remove || m.reactions.length !== before)
      this.emit('reaction', m, { actorId: ME, reaction: { kind, ...(emoji ? { emoji } : {}), removed: remove } });
    return m;
  }
  async edit(messageId: string, text: string): Promise<Message> {
    const m = this.own(messageId);
    const previousText = m.text;
    m.editHistory = [...(m.editHistory ?? []), { text: m.text, at: m.editedAt ?? m.sentAt }];
    m.text = text.trim();
    m.editedAt = this.now();
    this.emit('edited', m, { actorId: ME, previousText });
    return m;
  }
  async unsend(messageId: string): Promise<Message> {
    const m = this.own(messageId);
    m.unsent = true;
    delete m.editedAt;
    delete m.editHistory;
    this.emit('unsent', m, { actorId: ME });
    return m;
  }
  async markRead(chatId: string, unread: boolean): Promise<number> {
    if (!this._chats.has(chatId)) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    const msgs = this.chatMessages(chatId).filter((m) => m.senderId !== ME && !m.system);
    if (unread) {
      // Only the latest incoming message is flagged; it counts as a change only if it was read.
      const last = msgs[msgs.length - 1];
      if (!last?.isRead) return 0;
      last.isRead = false;
      return 1;
    }
    const changed = msgs.filter((m) => !m.isRead);
    changed.forEach((m) => {
      m.isRead = true;
    });
    return changed.length;
  }
  async manageGroup(action: GroupAction, a: ManageGroupArgs): Promise<Chat> {
    const sys = (c: Chat, type: NonNullable<Message['system']>['type'], detail: string, title?: string | null) => {
      const m: Message = {
        messageId: `m${this._nextMsg++}`,
        chatId: c.chatId,
        senderId: ME,
        service: c.service,
        sentAt: this.now(),
        text: '',
        isRead: true,
        reactions: [],
        attachmentIds: [],
        system: { type, detail, ...(title !== undefined ? { title } : {}) },
      };
      this.insert(m);
      this.emit('new', m, { actorId: ME });
    };
    const known = (id: string) => {
      if (!this._people.has(id))
        throw new ToolError(
          'person_not_found',
          `No person has id "${id}".`,
          'Use find or get_person to look up person_ids.',
        );
      return id;
    };
    // Stand-in for an IDS lookup: a person reachable only by SMS (or a short code) can't join an iMessage group.
    const requireIMessage = (ids: string[]) => {
      const bad = ids.filter(
        (id) => !this._people.get(id)?.handles.some((h) => h.services.includes('iMessage') && !isShortCode(h.address)),
      );
      if (bad.length)
        throw new ToolError(
          'not_imessage',
          `${bad.map((id) => this.personName(id)).join(', ')} ${bad.length > 1 ? "aren't" : "isn't"} on iMessage, so ${bad.length > 1 ? 'they' : 'that person'} can't be in an iMessage group.`,
          'Text them separately with send_message, or ask the user for an iMessage phone number or email for them.',
        );
    };
    if (action === 'create') {
      const ids = [
        ...new Set([
          ...(a.participantIds ?? []).map(known),
          ...(a.participantAddresses ?? []).map((x) => this.personFor(x).personId),
        ]),
      ];
      requireIMessage(ids);
      const c: Chat = {
        chatId: `iMessage;+;chat${10000 + this._nextId++}`,
        type: 'group',
        service: 'iMessage',
        participantIds: ids,
        displayName: a.title || null,
        createdAt: this.now(),
        labels: [],
      };
      this._chats.set(c.chatId, c);
      if (a.title) sys(c, 'renamed', `named the conversation "${a.title}"`, a.title);
      return c;
    }
    const c = a.chatId ? this._chats.get(a.chatId) : undefined;
    if (c?.type !== 'group')
      throw new ToolError(
        'not_a_group',
        'That conversation is not a group chat.',
        'Pass a group chat (its chat_id or name); 1:1 chats have no members to manage.',
      );
    if (action === 'rename') {
      const next = a.title || null;
      if (c.displayName && c.displayName !== next)
        c.formerTitles = [
          c.displayName,
          ...(c.formerTitles ?? []).filter((t) => t !== c.displayName && t !== next),
        ].slice(0, 5);
      else if (next && c.formerTitles?.includes(next)) c.formerTitles = c.formerTitles.filter((t) => t !== next);
      c.displayName = next;
      sys(c, 'renamed', next ? `named the conversation "${next}"` : 'removed the conversation name', next);
    } else if (action === 'add' || action === 'remove') {
      const pid = a.personId ? known(a.personId) : this.personFor(a.address!).personId;
      if (action === 'add') {
        if (c.participantIds.includes(pid)) return c;
        requireIMessage([pid]);
        c.participantIds.push(pid);
        sys(c, 'added', `added ${this.personName(pid)} to the conversation`);
      } else {
        if (!c.participantIds.includes(pid))
          throw new ToolError(
            'not_a_member',
            `${this.personName(pid)} isn't in ${this.chatTitle(c)}.`,
            'Nothing was changed. Check the members with get_conversation.',
          );
        c.participantIds = c.participantIds.filter((id) => id !== pid);
        sys(c, 'removed', `removed ${this.personName(pid)} from the conversation`);
      }
    } else if (action === 'leave') sys(c, 'left', 'left the conversation');
    else sys(c, 'icon_changed', 'changed the group photo');
    return c;
  }

  // ---------- sidecar: aliases, notes, labels, reminders, drafts
  updatePerson(personId: string, p: PersonPatch): Person {
    const person = this._people.get(personId);
    if (!person) throw new ToolError('person_not_found', `No person has id "${personId}".`);
    return applyPersonPatch(person, p);
  }
  labelChat(chatId: string, add: string[], remove: string[]): Chat {
    const c = this._chats.get(chatId);
    if (!c) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    c.labels = [...new Set([...c.labels.filter((l) => !normLabels(remove).includes(l)), ...normLabels(add)])];
    return c;
  }
  labelCounts() {
    const counts = new Map<string, number>();
    for (const c of this._chats.values()) for (const l of c.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }
  setReminder(
    chatId: string,
    remindAt: number | null,
    note: string | undefined,
    dismiss: boolean | DismissWhen,
  ): Reminder | null {
    if (!this._chats.has(chatId)) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    const existing = [...this._reminders.values()].find((r) => r.chatId === chatId);
    if (existing) this._reminders.delete(existing.reminderId);
    if (remindAt === null) return null;
    for (const d of [...this._dismissed.values()]) if (d.chatId === chatId) this._dismissed.delete(d.reminderId);
    const r = newReminder(`r${this._nextId++}`, chatId, remindAt, note, dismiss, this.now());
    this._reminders.set(r.reminderId, r);
    return r;
  }
  reminders(): Reminder[] {
    // i_reply: your next message dismisses it; they_reply: theirs does (group events and tapbacks don't count).
    for (const r of [...this._reminders.values()]) {
      if (r.dismissWhen === 'never') continue;
      const mine = r.dismissWhen === 'i_reply';
      const by = this.chatMessages(r.chatId).find(
        (m) => !m.system && m.sentAt > r.createdAt && (m.senderId === ME) === mine,
      );
      if (!by) continue;
      this._reminders.delete(r.reminderId);
      this._dismissed.set(r.reminderId, { ...r, dismissedAt: by.sentAt, dismissedBy: by.messageId });
    }
    return [...this._reminders.values()].sort((a, b) => a.remindAt - b.remindAt);
  }
  dismissedReminders(): DismissedReminder[] {
    this.reminders();
    const cutoff = this.now() - DISMISSED_KEEP_MS;
    for (const d of [...this._dismissed.values()]) if (d.dismissedAt < cutoff) this._dismissed.delete(d.reminderId);
    return [...this._dismissed.values()].sort((a, b) => b.dismissedAt - a.dismissedAt);
  }
  createDraft(d: DraftInput): Draft {
    const draft = newDraft(d, `d${this._nextId++}`, this.now());
    this._drafts.set(draft.draftId, draft);
    return draft;
  }
  drafts(): Draft[] {
    return [...this._drafts.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  private draft(id: string): Draft {
    const d = this._drafts.get(id);
    if (!d) throw draftNotFound(id);
    return d;
  }
  updateDraft(id: string, patch: DraftPatch): Draft {
    const d = this.draft(id);
    requireUnsent(d);
    return applyDraftPatch(d, patch, this.now());
  }
  markDraftFailed(id: string, code: string): Draft {
    const d = this.draft(id);
    requireUnsent(d);
    d.status = 'failed';
    d.error = code;
    return d;
  }
  deleteDraft(id: string) {
    this.draft(id);
    this._drafts.delete(id);
  }
  async sendDraft(id: string): Promise<SendResult> {
    const d = this.draft(id);
    requireUnsent(d);
    const out = draftSend(d);
    if (!d.text.trim() && !out.files.length) {
      d.status = 'failed';
      d.error = 'empty_message';
      return emptyDraftResult(d);
    }
    const r = await this.send(out.target, d.text, out.files, 'auto', out.key, out.extras);
    if (r.disposition === 'failed') {
      d.status = 'failed';
      d.attempts = (d.attempts ?? 0) + 1;
      d.error = r.error?.code ?? 'failed';
      delete d.sentMessageId;
    } else {
      d.status = 'sent';
      d.sentMessageId = r.message?.messageId;
      delete d.error;
    }
    return r;
  }
}
