// The live store: chat.db and Contacts on this Mac, read through the modules in this folder and written through
// Messages. LiveStore only wires them together; each MessageStore member hands off to the module that owns it.

import { randomUUID } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import type { BridgeConfig } from '../config.js';
import { ToolError } from '../lib/errors.js';
import { DAY_MS, MINUTE_MS } from '../lib/units.js';
import type { MessageStore } from '../store/ports.js';
import { Analytics } from './analytics.js';
import { AttachmentCatalog } from './attachmentCatalog.js';
import { AttachmentFiles } from './attachments.js';
import { ChangeFeed } from './changeFeed.js';
import { type LiveContext, openLiveContext } from './context.js';
import type { Directory } from './directory.js';
import { sweep } from './housekeeping.js';
import { Hydrator } from './hydrate.js';
import type { PrivateApi } from './imsgRpc.js';
import { execChild, OSA_NOT_AUTHORIZED_RE } from './macos.js';
import { MessageReader } from './messages.js';
import { Organizer } from './organizer.js';
import { PrivateActions } from './privateActions.js';
import { SearchIndex } from './searchIndex.js';
import type { SendDeps } from './sender.js';
import type { Sidecar } from './sidecar.js';
import { lookupStoredSend } from './storedSends.js';
import { Summaries } from './summaries.js';

export interface LiveStoreOptions {
  /**
   * Builds the send function from what sending needs; the bridge passes createSender from sender.ts. Without it, sends
   * fail with send_unavailable.
   */
  sender?: (deps: SendDeps) => MessageStore['send'];
  /** imsg's helper inside Messages, for the Private API tools. Without it they fail with requires_private_api. */
  privateApi?: PrivateApi;
}

export class LiveStore implements MessageStore {
  readonly mode = 'live' as const;
  readonly timeZone: string;
  readonly bootId = randomUUID().slice(0, 8);
  readonly side: Sidecar;
  automation: 'ok' | 'denied' | 'messages_unavailable' | 'unchecked' = 'unchecked';
  private ctx: LiveContext;
  private dir: Directory;
  private catalog: AttachmentCatalog;
  private summaries: Summaries;
  private index: SearchIndex;
  private reader: MessageReader;
  private analytics: Analytics;
  private feed: ChangeFeed;
  private files: AttachmentFiles;
  private actions: PrivateActions;
  private organizer: Organizer;
  private sendImpl?: MessageStore['send'];
  private watcher?: FSWatcher;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private cfg: BridgeConfig,
    opts: LiveStoreOptions = {},
  ) {
    this.timeZone = cfg.tools.timeZone;
    this.ctx = openLiveContext(cfg);
    this.side = this.ctx.side;
    this.dir = this.ctx.dir;
    this.catalog = new AttachmentCatalog(this.ctx);
    const hydrator = new Hydrator(this.ctx, this.catalog);
    this.summaries = new Summaries(this.ctx, hydrator);
    this.index = new SearchIndex(this.ctx, hydrator, this.catalog);
    this.reader = new MessageReader(this.ctx, hydrator, this.index);
    this.analytics = new Analytics(this.ctx, hydrator, this.reader, this.summaries);
    const message = (id: string) => this.reader.message(id);
    const invalidateSummaries = () => this.summaries.invalidate();
    const reloadDirectory = () => this.reloadDirectory();
    this.feed = new ChangeFeed(this.ctx, { message, invalidateSummaries, reloadDirectory, index: this.index });
    this.files = new AttachmentFiles(this.ctx, this.catalog);
    const poll = () => this.feed.poll();
    this.actions = new PrivateActions(
      this.ctx,
      { message, poll, reloadDirectory, invalidateSummaries },
      opts.privateApi,
    );
    const send: MessageStore['send'] = (...a) => this.send(...a);
    this.organizer = new Organizer(this.ctx, { send, invalidateSummaries, bootId: this.bootId, now: () => this.now() });
    this.organizer.settleInterruptedSends();
    this.reloadDirectory();
    // Last: the sender reads chat.db, the sidecar and the directory as soon as it is built.
    this.sendImpl = opts.sender?.(this);
  }

  get redactCodes(): boolean {
    return this.cfg.tools.redactCodes;
  }

  /** Starts change polling, the WAL watcher, daily housekeeping and the background search index build. */
  start() {
    this.feed.markStart();
    const every = (ms: number, fn: () => void) => this.timers.push(setInterval(fn, ms).unref());
    every(1500, () => this.poll());
    every(5 * MINUTE_MS, () => {
      try {
        this.reloadDirectory();
      } catch (e) {
        console.error('directory reload failed; keeping the previous one:', (e as Error).message);
      }
    });
    try {
      let t: NodeJS.Timeout | undefined;
      this.watcher = watch(`${this.cfg.chatDbPath}-wal`, () => {
        clearTimeout(t);
        t = setTimeout(() => this.poll(), 150);
      });
    } catch {
      /* polling still covers it */
    }
    sweep(this.ctx);
    every(DAY_MS, () => sweep(this.ctx));
    this.index.start();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.watcher?.close();
  }

  /** Reloads people and chats; their summaries go with them. */
  private reloadDirectory() {
    this.dir.load();
    this.catalog.clear();
    this.summaries.invalidate();
  }

  /** Asks Messages a harmless question (no send) so macOS shows its Automation prompt now, not on the first send. */
  async checkAutomation(): Promise<void> {
    try {
      await execChild('osascript', ['-e', 'tell application "Messages" to count accounts'], { timeout: 60_000 });
      this.automation = 'ok';
    } catch (e) {
      const m = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      this.automation = OSA_NOT_AUTHORIZED_RE.test(m) ? 'denied' : 'messages_unavailable';
    }
  }

  health() {
    const idx = this.index.status();
    return {
      chat_db_readable: true,
      automation_messages: this.automation,
      private_api: this.actions.healthText(),
      search_index: idx.error ? `failed: ${idx.error}` : idx.ready ? 'ready' : `building ${idx.percent}%`,
      text_extraction: this.files.extractorHealth(),
      last_poll_rowid: this.feed.lastRowid,
      hidden_entries: this.cfg.hide.length,
    };
  }

  // For the send module (sender.ts) and the bridge.
  get chatDb() {
    return this.ctx.db;
  }
  /** chat.db row id of a chat, if it is visible. */
  chatRowid = (chatId: string) => this.dir.chatRec(chatId)?.rowid;
  invalidateSummaries = () => this.summaries.invalidate();
  refreshDirectory = () => this.reloadDirectory();

  send: MessageStore['send'] = (target, text, attachments, service, idempotencyKey, extras) => {
    if (!this.sendImpl)
      throw new ToolError(
        'send_unavailable',
        'Sending is not set up on this Mac yet.',
        'Tell the user. Reading and searching work.',
      );
    return this.sendImpl(target, text, attachments, service, idempotencyKey, extras);
  };

  /** The outcome of an earlier send with this key, for send_message to replay before any policy check. */
  idempotencyLookup = (key: string) => lookupStoredSend(this.side, this.bootId, key, this.message);

  now = () => Date.now();

  // People and chats: directory.ts
  me = () => this.dir.me();
  people = () => this.dir.people();
  person = (id: string) => this.dir.person(id);
  chats = () => this.dir.chats();
  chat = (id: string) => this.dir.chat(id);
  personName = (id: string) => this.dir.personName(id);
  chatTitle: MessageStore['chatTitle'] = (c) => this.dir.chatTitle(c);
  chatSummaries = () => this.summaries.chatSummaries();
  summarizeChat = (chatId: string) => this.summaries.summarizeChat(chatId);

  // Messages: messages.ts, searchIndex.ts, analytics.ts
  message = (id: string) => this.reader.message(id);
  pageChat: MessageStore['pageChat'] = (chatId, filter, o) => this.reader.pageChat(chatId, filter, o);
  listMessages: MessageStore['listMessages'] = (filter, o) => this.reader.listMessages(filter, o);
  messagesAround: MessageStore['messagesAround'] = (...a) => this.reader.messagesAround(...a);
  threadReplies = (originatorId: string) => this.reader.threadReplies(originatorId);
  search: MessageStore['search'] = (filter, o) => this.index.search(filter, o);
  indexStatus = () => this.index.status();
  personActivity = (personId: string) => this.analytics.personActivity(personId);
  chatActivity = (chatId: string) => this.analytics.chatActivity(chatId);
  stats: MessageStore['stats'] = (groupBy, metric, filter) => this.analytics.stats(groupBy, metric, filter);
  counts = () => this.analytics.counts();

  // Attachments: attachmentCatalog.ts, attachments.ts
  attachment = (id: string) => this.catalog.get(id);
  /** Absolute path of an attachment on disk, for previews and downloads on the bridge. */
  attachmentPath = (id: string) => this.catalog.path(id);
  listAttachments: MessageStore['listAttachments'] = (f, o) => this.catalog.list(f, o);
  attachmentPreview = (id: string, maxDimension: number) => this.files.attachmentPreview(id, maxDimension);
  attachmentText = (id: string) => this.files.attachmentText(id);
  attachmentFile = (id: string) => this.files.attachmentFile(id);
  /** Compiles the text extractor at startup, so the first request doesn't wait for it. */
  warmExtractor = () => this.files.warmExtractor();

  // Updates: changeFeed.ts
  poll = () => this.feed.poll();
  updatesSince = (seq: number) => this.feed.updatesSince(seq);
  latestSeq = () => this.feed.latestSeq();
  oldestSeq = () => this.feed.oldestSeq();
  waitForUpdate = (afterSeq: number, timeoutMs: number) => this.feed.waitForUpdate(afterSeq, timeoutMs);

  // Private API: privateActions.ts
  privateApiStatus = () => this.actions.privateApiStatus();
  privateCall: PrivateActions['privateCall'] = (method, params) => this.actions.privateCall(method, params);
  guidOf = (messageId: string) => this.actions.guidOf(messageId);
  react: MessageStore['react'] = (...a) => this.actions.react(...a);
  edit = (messageId: string, text: string) => this.actions.edit(messageId, text);
  unsend = (messageId: string) => this.actions.unsend(messageId);
  markRead = (chatId: string, unread: boolean) => this.actions.markRead(chatId, unread);
  setTyping = (chatId: string, typing: boolean) => this.actions.setTyping(chatId, typing);
  manageGroup: MessageStore['manageGroup'] = (action, a) => this.actions.manageGroup(action, a);

  // Organizer: organizer.ts
  updatePerson: MessageStore['updatePerson'] = (personId, p) => this.organizer.updatePerson(personId, p);
  labelChat: MessageStore['labelChat'] = (chatId, add, remove) => this.organizer.labelChat(chatId, add, remove);
  labelCounts = () => this.organizer.labelCounts();
  setReminder: MessageStore['setReminder'] = (...a) => this.organizer.setReminder(...a);
  reminders = () => this.organizer.reminders();
  dismissedReminders = () => this.organizer.dismissedReminders();
  createDraft: MessageStore['createDraft'] = (d) => this.organizer.createDraft(d);
  drafts = () => this.organizer.drafts();
  updateDraft: MessageStore['updateDraft'] = (id, patch) => this.organizer.updateDraft(id, patch);
  markDraftFailed = (id: string, code: string) => this.organizer.markDraftFailed(id, code);
  deleteDraft = (id: string) => this.organizer.deleteDraft(id);
  sendDraft = (id: string) => this.organizer.sendDraft(id);
}
