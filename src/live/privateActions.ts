// Actions only imsg's helper inside Messages can do: tapbacks, edit and unsend, read receipts, typing and group
// changes. Each call checks the helper first, maps its errors to tool errors with retry advice, and waits until
// chat.db shows the change.

import { isShortCode } from '../lib/address.js';
import { PRIVATE_API_OFF, ToolError } from '../lib/errors.js';
import {
  type Chat,
  type GroupAction,
  type ManageGroupArgs,
  ME,
  type Message,
  type Reaction,
  type ReactionKind,
} from '../store/types.js';
import { handleKey } from './contacts.js';
import type { LiveContext } from './context.js';
import { ImsgError, type ImsgStatus, type PrivateApi } from './imsgRpc.js';
import { REAL, type Row } from './sql.js';
import { cleanText } from './typedstream.js';

/** What the agent called, for private-API error messages. */
const ACTION_LABEL: Record<string, string> = {
  tapback: 'react',
  'message.edit': 'edit_message',
  'message.unsend': 'unsend_message',
  read: 'mark_read',
  'chats.markUnread': 'mark_read unread=true',
  typing: 'set_typing',
  'chats.create': 'manage_group create',
  'group.rename': 'manage_group rename',
  'group.addParticipant': 'manage_group add',
  'group.removeParticipant': 'manage_group remove',
  'group.leave': 'manage_group leave',
  'group.setIcon': 'manage_group set_icon',
  'send.rich': 'send_message with reply_to or effect',
};

export interface ActionDeps {
  message(id: string): Message | undefined;
  /** Picks up the change in chat.db now instead of on the next poll. */
  poll(): void;
  reloadDirectory(): void;
  invalidateSummaries(): void;
}

export class PrivateActions {
  /** The helper's last status, reused for 30 s. */
  private apiState: { at: number; s: ImsgStatus } | null = null;

  /** api: imsg's helper; without it every action fails with requires_private_api. */
  constructor(
    private ctx: LiveContext,
    private deps: ActionDeps,
    private api?: PrivateApi,
  ) {}

  /** private_api for health: off, unchecked, ready, or why the helper isn't usable. */
  healthText(): string {
    return !this.api
      ? 'off'
      : !this.apiState
        ? 'unchecked'
        : this.apiState.s.bridgeReady
          ? 'ready'
          : `unavailable: ${(this.apiState.s.reason ?? 'helper not loaded').split('\n')[0]}`;
  }

  async privateApiStatus(): Promise<ImsgStatus & { configured: boolean }> {
    if (!this.api) return { configured: false, bridgeReady: false, methods: [], reason: 'not configured' };
    if (!this.apiState || Date.now() - this.apiState.at > 30_000)
      this.apiState = { at: Date.now(), s: await this.api.status() };
    return { configured: true, ...this.apiState.s };
  }

  /**
   * Calls an imsg bridge method after checking the bridge is up, mapping its errors to tool errors with retry advice.
   */
  async privateCall<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.api) throw new ToolError(PRIVATE_API_OFF.code, PRIVATE_API_OFF.message, PRIVATE_API_OFF.fix);
    const label = ACTION_LABEL[method] ?? method;
    const s = await this.privateApiStatus();
    if (!s.bridgeReady)
      throw new ToolError(
        'private_api_unavailable',
        "The helper that lets the bridge react, edit and unsend isn't running inside Messages right now.",
        'Tell the user. On the Mac, run `imsg launch`. On macOS 26 that can need library validation turned off first.',
      );
    if (s.methods.length && !s.methods.includes(method))
      throw new ToolError(
        'not_supported',
        `${label} isn't available on this Mac.`,
        'Tell the user. Other actions still work.',
      );
    const check =
      method.startsWith('group.') || method === 'chats.create'
        ? 'Check the group with list_conversations or get_conversation before trying again. Do not retry blindly.'
        : 'Check the conversation (read_conversation or get_message) before trying again. Do not retry blindly.';
    let out: T;
    try {
      out = await this.api.call<T>(method, params);
    } catch (e) {
      this.apiState = null;
      if (e instanceof ToolError) throw e;
      if (!(e instanceof ImsgError)) {
        console.error(`private API ${method} threw`, (e as Error)?.stack ?? e);
        throw new ToolError('outcome_unknown', `${label} may or may not have gone through.`, check);
      }
      if (e.disposition === 'may_have_completed' || e.disposition === 'still_in_flight' || e.code === -32001)
        throw new ToolError('outcome_unknown', `${label} may or may not have gone through.`, check);
      if (e.code === -32003)
        throw new ToolError(
          'private_api_unavailable',
          'The helper inside Messages stopped responding.',
          'Tell the user. On the Mac, run `imsg launch`.',
        );
      if (e.code === -32004)
        throw new ToolError(
          'busy',
          `An earlier action through the helper is still unresolved, so ${label} was not run.`,
          "This request was not run. Check the earlier action's result with read_conversation or get_message, then try again in a minute; restarting the bridge clears this.",
        );
      if (e.code === -32602)
        throw new ToolError(
          'rejected',
          `${label} was not run: ${e.message.slice(0, 300)}`,
          'Nothing happened. Fix the arguments and try again; if they look right, tell the user.',
        );
      throw new ToolError(
        'private_api_error',
        `${label} failed: ${e.message.slice(0, 300)}`,
        e.retrySafe ? 'It did not start, so retrying is safe.' : `It may have gone through. ${check}`,
      );
    }
    // The audit write must never turn a completed action into an error.
    try {
      this.ctx.side.audit(method, typeof params.chat_guid === 'string' ? params.chat_guid : null, {
        method,
        ...(typeof params.reaction === 'string' ? { reaction: params.reaction } : {}),
      });
    } catch (e) {
      console.error('audit write failed', (e as Error).message);
    }
    return out;
  }

  guidOf(messageId: string): string {
    const r = this.ctx.stmt('select guid from message where ROWID = ?').get(Number(messageId.replace(/\D/g, ''))) as
      | Row
      | undefined;
    if (!r) throw new ToolError('message_not_found', `No message has id "${messageId}".`);
    return String(r.guid);
  }

  /** Re-reads a message until chat.db reflects a change (or a few seconds pass). */
  private async settle(messageId: string, done: (m: Message) => boolean, ms = 6000): Promise<Message> {
    const until = Date.now() + ms;
    let m = this.deps.message(messageId);
    while (m && !done(m) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 400));
      this.deps.poll();
      m = this.deps.message(messageId);
    }
    if (!m) throw new ToolError('message_not_found', `No message has id "${messageId}".`);
    return m;
  }

  private requireMessage(messageId: string): Message {
    const m = this.deps.message(messageId);
    if (!m) throw new ToolError('message_not_found', `No message has id "${messageId}".`);
    return m;
  }

  async react(
    messageId: string,
    kind: ReactionKind,
    _emoji: string | undefined,
    remove: boolean,
    part = 0,
  ): Promise<Message> {
    const m = this.requireMessage(messageId);
    if (kind === 'emoji')
      throw new ToolError(
        'unsupported_reaction',
        'Only the six standard tapbacks can be sent.',
        'Use love, like, dislike, laugh, emphasize or question.',
      );
    await this.privateCall('tapback', {
      chat_guid: m.chatId,
      message_guid: this.guidOf(messageId),
      reaction: kind,
      remove,
      part_index: part,
    });
    const onPart = (r: Reaction) => r.by === ME && (r.part ?? 0) === part;
    return this.settle(messageId, (x) =>
      remove ? !x.reactions.some(onPart) : x.reactions.some((r) => onPart(r) && r.kind === kind),
    );
  }

  async edit(messageId: string, text: string): Promise<Message> {
    const m = this.requireMessage(messageId);
    await this.privateCall('message.edit', { chat_guid: m.chatId, message_guid: this.guidOf(messageId), text });
    const want = cleanText(text);
    return this.settle(messageId, (x) => x.text === want || (!!x.editedAt && x.editedAt !== m.editedAt));
  }

  async unsend(messageId: string): Promise<Message> {
    const m = this.requireMessage(messageId);
    await this.privateCall('message.unsend', { chat_guid: m.chatId, message_guid: this.guidOf(messageId) });
    return this.settle(messageId, (x) => !!x.unsent);
  }

  async markRead(chatId: string, unread: boolean): Promise<number> {
    const c = this.ctx.dir.chatRec(chatId);
    if (!c) throw new ToolError('chat_not_found', `No conversation has chat_id "${chatId}".`);
    // Measured before the call (chat.db catches up after it returns), bypassing the summary cache.
    const incoming = `from message m join chat_message_join cmj on cmj.message_id = m.ROWID where cmj.chat_id = ? and m.is_from_me = 0 and ${REAL()}`;
    const before = unread
      ? Number(
          (
            this.ctx.db.prepare(`select m.is_read r ${incoming} order by cmj.message_date desc limit 1`).get(c.rowid) as
              | Row
              | undefined
          )?.r ?? 0,
        )
      : Number((this.ctx.db.prepare(`select count(*) n ${incoming} and m.is_read = 0`).get(c.rowid) as Row).n);
    await this.privateCall(unread ? 'chats.markUnread' : 'read', { chat_guid: c.chatId });
    this.deps.invalidateSummaries();
    return before;
  }

  async setTyping(chatId: string, typing: boolean): Promise<void> {
    await this.privateCall('typing', { chat_guid: chatId, typing });
  }

  async manageGroup(action: GroupAction, a: ManageGroupArgs): Promise<Chat> {
    // Never a short code: those can't be group members.
    const addressOf = (pid: string) => {
      const p = this.ctx.dir.peopleById.get(pid);
      const usable = p?.handles.filter((x) => !isShortCode(x.address)) ?? [];
      const h = usable.find((x) => x.services.includes('iMessage')) ?? usable[0];
      if (!h)
        throw new ToolError(
          'no_address',
          `${this.ctx.dir.personName(pid)} has no phone number or email that can be in a group.`,
          'Text them separately with send_message.',
        );
      return h.address;
    };
    const memberKey = (address: string) =>
      this.ctx.dir.personIdByKey.get(handleKey(address)) ?? `addr:${handleKey(address)}`;
    const settleGroup = async (guid: string | undefined, changed: (c: Chat) => boolean): Promise<Chat | undefined> => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 800));
        this.deps.reloadDirectory();
        const c = guid ? this.ctx.dir.chat(guid) : undefined;
        if (c && changed(c)) return c;
      }
      return undefined;
    };
    this.deps.reloadDirectory();
    if (action === 'create') {
      const addresses = [...new Set([...(a.participantIds ?? []).map(addressOf), ...(a.participantAddresses ?? [])])];
      const r = await this.privateCall<{ chat_guid?: string }>('chats.create', {
        addresses,
        ...(a.title ? { name: a.title } : {}),
      });
      const out = await settleGroup(r.chat_guid, () => true);
      if (!out)
        throw new ToolError(
          'outcome_unknown',
          'Messages accepted the new group, but it is not visible in chat.db yet.',
          'Check list_conversations in a moment before retrying. Do not create it again blindly.',
        );
      return out;
    }
    const c = a.chatId ? this.ctx.dir.chat(a.chatId) : undefined;
    if (c?.type !== 'group')
      throw new ToolError(
        'not_a_group',
        'That conversation is not a group chat.',
        'Pass a group chat (its chat_id or name); 1:1 chats have no members to manage.',
      );
    const members = [...c.participantIds].sort().join(',');
    if (action === 'rename') {
      await this.privateCall('group.rename', { chat_guid: c.chatId, name: a.title });
    } else if (action === 'add' || action === 'remove') {
      const key = a.personId ?? memberKey(a.address!);
      const isMember = c.participantIds.includes(key);
      if (action === 'add' && isMember) return c;
      if (action === 'remove' && !isMember)
        throw new ToolError(
          'not_a_member',
          `${a.personId ? this.ctx.dir.personName(a.personId) : a.address} isn't in ${this.ctx.dir.chatTitle(c)}.`,
          'Nothing was changed. Check the members with get_conversation.',
        );
      await this.privateCall(action === 'add' ? 'group.addParticipant' : 'group.removeParticipant', {
        chat_guid: c.chatId,
        address: a.personId ? addressOf(a.personId) : a.address,
      });
      const out = await settleGroup(c.chatId, (x) => [...x.participantIds].sort().join(',') !== members);
      if (!out)
        throw new ToolError(
          'outcome_unknown',
          `Messages accepted manage_group ${action}, but the member list in chat.db hasn't changed yet.`,
          'Check the group with get_conversation in a moment before trying again. Do not retry blindly.',
        );
      return out;
    } else if (action === 'leave') await this.privateCall('group.leave', { chat_guid: c.chatId });
    else
      await this.privateCall('group.setIcon', { chat_guid: c.chatId, ...(a.imagePath ? { file: a.imagePath } : {}) });
    await new Promise((r) => setTimeout(r, 800));
    this.deps.reloadDirectory();
    const out = this.ctx.dir.chat(c.chatId);
    if (!out)
      throw new ToolError(
        'outcome_unknown',
        'Messages accepted the change, but the group is not visible in chat.db yet.',
        'Check list_conversations in a moment before retrying.',
      );
    return out;
  }
}
