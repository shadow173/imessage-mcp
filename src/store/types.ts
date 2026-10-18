// Domain types shared by MockStore and LiveStore.

import type { AttachmentKind } from '../domain/attachments.js';
import { DAY_MS } from '../lib/units.js';

export type Service = 'iMessage' | 'SMS' | 'RCS';
export type ChatType = 'dm' | 'group';
export type ReactionKind = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question' | 'emoji';

/** "me" is the reserved sender/person id for the Mac's owner. */
export const ME = 'me';

export interface Person {
  personId: string;
  /** Contacts name. null when the handle has no Contacts card. */
  name: string | null;
  nicknames: string[];
  company?: string;
  /** Normalized addresses: E.164 phones and lowercased emails. Merged across services. */
  handles: { address: string; services: Service[] }[];
  /** Server-side, owner-managed. */
  aliases: string[];
  note?: string;
  labels: string[];
}

export interface Chat {
  /** Full chat.guid, e.g. "iMessage;-;+15555550142" or "iMessage;+;chat84621". */
  chatId: string;
  type: ChatType;
  service: Service;
  /** Group name if set. null for DMs and unnamed groups. */
  displayName: string | null;
  /** Other participants (never includes me). */
  participantIds: string[];
  createdAt: number;
  labels: string[];
  /** Earlier group names, newest first; the current displayName and empty names left out. */
  formerTitles?: string[];
}

/** Where a message goes: an existing chat, or a new 1:1 with an address (and the person it belongs to, if known). */
export type ChatTarget = { chat: Chat } | { newAddress: string; person?: Person };

export interface Reaction {
  kind: ReactionKind;
  emoji?: string;
  by: string; // personId or ME
  at: number;
  /** Which bubble of a multi-part message, from 0. Absent means 0. */
  part?: number;
}

export interface LinkPreview {
  url: string;
  title: string;
  site: string;
}

export interface SystemEvent {
  type: 'renamed' | 'added' | 'removed' | 'left' | 'icon_changed' | 'location_shared' | 'audio_kept' | 'shareplay';
  detail: string;
  /** The new group name on 'renamed' (null when the name was removed). */
  title?: string | null;
}

export interface Message {
  messageId: string;
  chatId: string;
  senderId: string; // personId or ME
  /** The handle an inbound message came from (E.164 phone, lowercase email, or short code). */
  senderAddress?: string;
  service: Service;
  sentAt: number; // epoch ms
  text: string;
  deliveredAt?: number;
  readAt?: number; // for my messages: when the recipient read it
  isRead: boolean; // for inbound: whether I've read it
  editedAt?: number;
  editHistory?: { text: string; at: number }[];
  unsent?: boolean;
  /** Inline-reply thread originator (thread_originator_guid). */
  replyToId?: string;
  reactions: Reaction[];
  attachmentIds: string[];
  link?: LinkPreview;
  effect?: string;
  appType?: string; // "Apple Cash $40.00", "Poll", ...
  system?: SystemEvent;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
  /** Bubbles on screen: each attachment and each text run between them (an app balloon is one). */
  partCount?: number;
  /**
   * Bubble order on screen (index = tapback part), when the store knows it; otherwise files come first, then the text.
   */
  parts?: MessagePart[];
}

export interface MessagePart {
  kind: 'text' | 'file';
  attachmentId?: string;
}

export interface Attachment {
  attachmentId: string;
  messageId: string;
  chatId: string;
  senderId: string;
  sentAt: number;
  name: string;
  mime: string;
  bytes: number;
  kind: AttachmentKind;
  width?: number;
  height?: number;
  durationS?: number;
  /** false when Messages in iCloud has offloaded the file and it isn't on this Mac. */
  onDevice?: boolean;
  /** Mock stand-in for OCR / PDF text / voice transcript. */
  extractedText?: string;
  /** Mock bytes for preview and download. */
  dataBase64?: string;
}

export type FromFilter = { kind: 'me' } | { kind: 'others' } | { kind: 'person'; personId: string };

export interface MessageFilter {
  chatIds?: string[];
  withPersonId?: string;
  from?: FromFilter;
  after?: number; // inclusive
  before?: number; // exclusive
  text?: string;
  chatType?: ChatType;
  service?: Service;
  hasAttachment?: boolean;
  attachmentKinds?: AttachmentKind[];
  hasLink?: boolean;
  /** Words in a shared link's URL or preview title; every word must appear. */
  linkQuery?: string;
  /** A shared link's site: matches the host or any subdomain of it ("example.com" matches www.example.com). */
  linkDomain?: string;
  unreadOnly?: boolean;
  includeSystem?: boolean;
}

/** Position in a chat's timeline: (sentAt, messageId). */
export interface MsgKey {
  t: number;
  id: string;
}

export interface ChatPage {
  items: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
  total: number;
}
export interface ListPage<T = Message> {
  items: T[];
  total: number;
}

export interface AttachmentFilter {
  chatId?: string;
  from?: FromFilter;
  kinds?: AttachmentKind[];
  nameQuery?: string;
  after?: number;
  before?: number;
}

export interface PersonActivity {
  messageCount: number;
  sentByMe: number;
  sentByThem: number;
  firstAt?: number;
  last?: Message;
  dmChatIds: string[];
  groupChatIds: string[];
  /** "YYYY-MM" (owner's time zone) -> messages, all history. */
  byMonth: Record<string, number>;
  /** Days on which each side sent the first 1:1 message. */
  daysStarted: { you: number; them: number };
  /** Messages in your 1:1 chats with them (both sides). */
  dmMessageCount?: number;
  /** Messages they sent in group chats. */
  sentByThemInGroups?: number;
  /** Your latest 1:1 message to them (group posts don't count). */
  lastFromMe?: Message;
  /** Their latest message anywhere. */
  lastFromThem?: Message;
}

export interface ChatActivity {
  total: number;
  firstAt?: number;
  /** personId or ME -> messages */
  bySender: Record<string, number>;
  last30Days: number;
  attachments: number;
  links: number;
  groupEvents: Message[];
}

export type StatGroup = 'person' | 'chat' | 'month' | 'weekday' | 'hour';
export type StatMetric = 'messages' | 'sent' | 'received' | 'attachments';
export interface StatRow {
  key: string;
  label: string;
  value: number /** A month the window only partly covers. */;
  partial?: boolean;
}

export interface ChatSummary {
  chat: Chat;
  title: string;
  unreadCount: number;
  lastMessage?: Message;
  needsReply: boolean;
  messageCount: number;
  unknownSender: boolean;
}

export interface UpdateEvent {
  seq: number;
  type: 'new' | 'edited' | 'unsent' | 'delivered' | 'read' | 'reaction';
  messageId: string;
  chatId: string;
  at: number;
  /** Who caused it: ME or a person_id (the reactor, the sender, the reader of a 1:1 receipt). */
  actorId?: string;
  reaction?: { kind: ReactionKind; emoji?: string; removed: boolean };
  /** On 'edited': the text before this edit, when known. */
  previousText?: string;
}

/** A file a draft will send: a forwarded attachment or a URL fetched at send time (no bytes stored). */
export interface DraftAttachment {
  filename: string;
  mime: string;
  url?: string;
  sourceAttachmentId?: string;
}

export interface Draft {
  draftId: string;
  chatId: string | null; // null when the recipient is a brand-new address
  toAddress?: string;
  text: string;
  attachmentNames: string[];
  sendAt?: number;
  note?: string;
  status: 'draft' | 'scheduled' | 'sent' | 'failed';
  createdAt: number;
  sentMessageId?: string;
  /** Why it failed (a tool error code such as missed_window, send_disabled, not_delivered). */
  error?: string;
  /** The user approved sending to a recipient outside the allowlist. */
  confirmed?: boolean;
  /** Failed send attempts so far; part of the idempotency key so a retry really resends. */
  attempts?: number;
  replyTo?: string;
  effect?: string;
  attachments?: DraftAttachment[];
}

/** A new draft as create_draft gives it; the store adds the id, status, creation time and attempt count. */
export type DraftInput = Omit<Draft, 'draftId' | 'status' | 'createdAt' | 'error' | 'attempts'>;

/** What manage_drafts update can change. sendAt null unschedules. */
export interface DraftPatch {
  text?: string;
  sendAt?: number | null;
  note?: string;
  confirmed?: boolean;
}

/** What update_person can change on a person. */
export interface PersonPatch {
  addAliases?: string[];
  removeAliases?: string[];
  note?: string;
  addLabels?: string[];
  removeLabels?: string[];
}

export type DismissWhen = 'i_reply' | 'they_reply' | 'never';

export interface Reminder {
  reminderId: string;
  chatId: string;
  remindAt: number;
  note?: string;
  /** i_reply: your next message cancels it; they_reply: theirs does; never: only clearing does. */
  dismissWhen: DismissWhen;
  /** Kept for older callers: dismissWhen === 'they_reply'. */
  dismissOnReply: boolean;
  createdAt: number;
}

/** A reminder a message cleared (dismiss_when), kept for a week so tools can say it was auto-dismissed and by what. */
export interface DismissedReminder extends Reminder {
  dismissedAt: number;
  /** The message that cleared it. */
  dismissedBy?: string;
}

/** How long auto-dismissed reminders stay listed. */
export const DISMISSED_KEEP_MS = 7 * DAY_MS;

/** sourceAttachmentId forwards a file already in Messages; filename and mime are still filled in by the tool. */
export interface OutgoingAttachment {
  filename: string;
  mime: string;
  base64?: string;
  url?: string;
  sourceAttachmentId?: string;
}

/** Private-API extras on a send: an inline reply target (message_id) and a bubble or screen effect name. */
export interface SendExtras {
  replyTo?: string;
  effect?: string;
}

export interface SendAttachmentResult {
  filename: string;
  messageId: string | null;
  status: 'delivered' | 'sent' | 'failed' | 'unconfirmed';
  error?: string;
}

export interface SendResult {
  disposition: 'sent' | 'delivered' | 'failed' | 'may_have_completed' | 'still_in_flight';
  message?: Message;
  chatId: string;
  error?: { code: string; message: string; fix?: string };
  retrySafe: boolean;
  /** True when this result is the stored outcome of an earlier call with the same idempotency key. */
  replayed?: boolean;
  /** Per-file outcome when files were sent. */
  attachments?: SendAttachmentResult[];
}

export const GROUP_ACTIONS = ['create', 'rename', 'add', 'remove', 'set_icon', 'leave'] as const;
export type GroupAction = (typeof GROUP_ACTIONS)[number];

/**
 * The tool layer checks these per action before calling a store (policy/groupArgs.ts): create has participants, every
 * other action a group chatId, rename a title, and add and remove a personId or an address.
 */
export interface ManageGroupArgs {
  chatId?: string;
  title?: string;
  participantIds?: string[];
  participantAddresses?: string[];
  personId?: string;
  address?: string;
  imagePath?: string;
}
