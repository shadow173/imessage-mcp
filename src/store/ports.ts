// What a store offers, split by role. MessageStore is all of them: MockStore implements it in memory; LiveStore reads
// chat.db and the AddressBook databases, and keeps its own state (aliases, drafts, reminders, the search index) in the
// sidecar SQLite. Code that needs one role can ask for just that one.

import type {
  Attachment,
  AttachmentFilter,
  Chat,
  ChatActivity,
  ChatPage,
  ChatSummary,
  DismissedReminder,
  DismissWhen,
  Draft,
  DraftInput,
  DraftPatch,
  GroupAction,
  ListPage,
  ManageGroupArgs,
  Message,
  MessageFilter,
  MsgKey,
  OutgoingAttachment,
  Person,
  PersonActivity,
  PersonPatch,
  ReactionKind,
  Reminder,
  SendExtras,
  SendResult,
  Service,
  StatGroup,
  StatMetric,
  StatRow,
  UpdateEvent,
} from './types.js';

export interface StoreInfo {
  readonly mode: 'mock' | 'live';
  readonly timeZone: string;
  /** Whether verification codes are hidden (REDACT_CODES). */
  readonly redactCodes: boolean;
  /** Changes on every restart; update cursors carry it so a stale seq is detected. */
  readonly bootId: string;
  now(): number;
  /** The live store reports the Mac's state; the mock has no machine to report on and leaves it out. */
  health?(): Record<string, unknown>;
}

/** People and chats: who the owner talks to, and one summary line per chat. */
export interface DirectoryPort {
  me(): { name: string; handles: string[] };
  people(): Person[];
  person(personId: string): Person | undefined;
  chats(): Chat[];
  chat(chatId: string): Chat | undefined;
  chatTitle(chat: Chat): string;
  personName(personId: string): string;
  summarizeChat(chatId: string): ChatSummary;
  /** Every visible chat with its last message and unread count, computed in one pass. */
  chatSummaries(): ChatSummary[];
}

/** Messages: by id, a window of one chat, filtered lists across chats, and full-text search. */
export interface ReaderPort {
  message(messageId: string): Message | undefined;
  /** A window of one chat, oldest first. anchor=end starts at the newest messages. */
  pageChat(
    chatId: string,
    filter: MessageFilter,
    opts: { limit: number; before?: MsgKey; after?: MsgKey; anchor: 'start' | 'end' },
  ): ChatPage;
  /** Filtered messages across chats, paged by offset. */
  listMessages(filter: MessageFilter, opts: { order: 'asc' | 'desc'; limit: number; offset: number }): ListPage;
  /** Full-text search. Throws ToolError index_building while the live index is incomplete. */
  search(
    filter: MessageFilter & { text: string },
    opts: { sort: 'relevance' | 'newest' | 'oldest'; limit: number; offset: number; match?: 'all' | 'any' },
  ): ListPage;
  /** The message plus neighbors in its chat, oldest first. */
  messagesAround(messageId: string, before: number, after: number, includeSystem?: boolean): Message[];
  threadReplies(originatorId: string): Message[];
}

/** Counts: per person, per chat, and grouped stats. */
export interface AnalyticsPort {
  personActivity(personId: string): PersonActivity;
  chatActivity(chatId: string): ChatActivity;
  stats(groupBy: StatGroup, metric: StatMetric, filter: MessageFilter): StatRow[];
  counts(): { people: number; chats: number; messages: number };
}

/** Attachments: metadata and lists, and on the live store previews, extracted text and the bytes. */
export interface AttachmentPort {
  attachment(attachmentId: string): Attachment | undefined;
  /** A viewable image of an attachment (photo converted, or a video/PDF thumbnail); null when there is none. */
  attachmentPreview(attachmentId: string, maxDimension: number): Promise<{ mime: string; base64: string } | null>;
  /** Extracted text: PDF text, OCR for images, Word/RTF/plain text. null when there is none; may throw unavailable. */
  attachmentText(attachmentId: string): Promise<string | null>;
  /** Raw bytes for download links, with HEIC converted to JPEG; null when the file can't be served. */
  attachmentFile(attachmentId: string): Promise<{ mime: string; name: string; data: Buffer } | null>;
  listAttachments(filter: AttachmentFilter, opts: { limit: number; offset: number }): ListPage<Attachment>;
}

/** The numbered changes behind get_updates (see store/eventLog.ts). */
export interface UpdateFeedPort {
  updatesSince(seq: number): UpdateEvent[];
  latestSeq(): number;
  /** The oldest seq still held (latestSeq() + 1 when none are held). */
  oldestSeq(): number;
  waitForUpdate(afterSeq: number, timeoutMs: number): Promise<void>;
}

/** Sending (AppleScript in live mode), with idempotency keys. */
export interface SenderPort {
  /**
   * Read-only: the stored outcome of an earlier send with this key (never a retry-safe failure), with its fingerprint
   * when known, or 'in_progress' while that send is still running. send_message replays it before any policy check.
   */
  idempotencyLookup(key: string): { result: SendResult; fp?: string } | 'in_progress' | undefined;
  send(
    target: { chatId?: string; address?: string },
    text: string,
    attachments: OutgoingAttachment[],
    service: Service | 'auto',
    idempotencyKey: string,
    extras?: SendExtras,
  ): Promise<SendResult>;
}

/** What only the Private API can do (live mode: imsg's helper injected into Messages). */
export interface PrivateActionsPort {
  react(
    messageId: string,
    kind: ReactionKind,
    emoji: string | undefined,
    remove: boolean,
    part?: number,
  ): Promise<Message>;
  edit(messageId: string, text: string): Promise<Message>;
  unsend(messageId: string): Promise<Message>;
  markRead(chatId: string, unread: boolean): Promise<number>;
  setTyping(chatId: string, typing: boolean): Promise<void>;
  manageGroup(action: GroupAction, args: ManageGroupArgs): Promise<Chat>;
}

/** What the owner and agent add on top of Messages: aliases, notes, labels, reminders and drafts. */
export interface OrganizerPort {
  updatePerson(personId: string, patch: PersonPatch): Person;
  labelChat(chatId: string, add: string[], remove: string[]): Chat;
  labelCounts(): { name: string; count: number }[];
  /** dismiss: a DismissWhen, or the older boolean (true = they_reply, false = never). */
  setReminder(
    chatId: string,
    remindAt: number | null,
    note: string | undefined,
    dismiss: boolean | DismissWhen,
  ): Reminder | null;
  reminders(): Reminder[];
  /** Reminders a message cleared in the last 7 days, newest first. */
  dismissedReminders(): DismissedReminder[];
  createDraft(d: DraftInput): Draft;
  drafts(): Draft[];
  /** Updating a failed draft makes it a draft again (scheduled when sendAt is still ahead). */
  updateDraft(draftId: string, patch: DraftPatch): Draft;
  /** For the scheduler: marks a draft failed with a tool error code, without sending. */
  markDraftFailed(draftId: string, code: string): Draft;
  deleteDraft(draftId: string): void;
  /**
   * Sends with key draft:<id>:<attempts>; a failed disposition bumps attempts. ToolErrors (in_progress, ...) propagate
   * untouched.
   */
  sendDraft(draftId: string): Promise<SendResult>;
}

/** The seam between the tools and the data: every role at once. */
export interface MessageStore
  extends StoreInfo,
    DirectoryPort,
    ReaderPort,
    AnalyticsPort,
    AttachmentPort,
    UpdateFeedPort,
    SenderPort,
    PrivateActionsPort,
    OrganizerPort {}
