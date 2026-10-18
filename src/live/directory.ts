// Who and what the live store knows about: Contacts cards, chat.db handles and chats, and what HIDE removes.

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BridgeConfig } from '../config.js';
import { chatGuidSuffix, isChatGuid, sameChatGuid } from '../domain/chatGuid.js';
import { chatTitle, personDisplayName } from '../domain/naming.js';
import { getOrInit } from '../lib/collections.js';
import { type Chat, ME, type MessageFilter, type Person, type Service } from '../store/types.js';
import { handleKey, loadContacts } from './contacts.js';
import type { Sidecar } from './sidecar.js';
import { CHAT_STYLE_GROUP, type MsgRow, optStr, type Row, serviceOf } from './sql.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);

/** A chat with its chat.db row id. */
export interface ChatRec extends Chat {
  rowid: number;
}

/** Everything one load reads. A load builds a whole new one, so a reload that fails part way changes nothing. */
interface Snapshot {
  handleKeyByRowid: Map<number, string>;
  handleRowidsByKey: Map<string, number[]>;
  peopleById: Map<string, Person>;
  personIdByKey: Map<string, string>;
  chatsByGuid: Map<string, ChatRec>;
  chatsByRowid: Map<number, ChatRec>;
  hiddenChatRowids: Set<number>;
  me: { name: string; handles: string[] };
}

const EMPTY: Snapshot = {
  handleKeyByRowid: new Map(),
  handleRowidsByKey: new Map(),
  peopleById: new Map(),
  personIdByKey: new Map(),
  chatsByGuid: new Map(),
  chatsByRowid: new Map(),
  hiddenChatRowids: new Set(),
  me: { name: 'Me', handles: [] },
};

export class Directory {
  private s: Snapshot = EMPTY;

  constructor(
    private db: DatabaseSync,
    private side: Sidecar,
    private cfg: BridgeConfig,
  ) {}

  /** Reloads contacts, handles and chats. If that fails part way, the previous directory stays in place. */
  load() {
    this.s = this.read();
  }

  /** handle.ROWID to its normalized address. */
  get handleKeyByRowid(): ReadonlyMap<number, string> {
    return this.s.handleKeyByRowid;
  }
  /** Normalized address to person id, for every visible handle. */
  get personIdByKey(): ReadonlyMap<string, string> {
    return this.s.personIdByKey;
  }
  get peopleById(): ReadonlyMap<string, Person> {
    return this.s.peopleById;
  }
  /** Visible chats by chat.ROWID. */
  get chatsByRowid(): ReadonlyMap<number, ChatRec> {
    return this.s.chatsByRowid;
  }
  get chatsByGuid(): ReadonlyMap<string, ChatRec> {
    return this.s.chatsByGuid;
  }
  /** Chats HIDE removes; every query leaves their rows out. */
  get hiddenChatRowids(): ReadonlySet<number> {
    return this.s.hiddenChatRowids;
  }

  me() {
    return this.s.me;
  }
  people(): Person[] {
    return [...this.s.peopleById.values()];
  }
  person(id: string) {
    return this.s.peopleById.get(id);
  }
  chats(): Chat[] {
    return [...this.s.chatsByGuid.values()];
  }
  chat(id: string): Chat | undefined {
    const direct = this.s.chatsByGuid.get(id);
    if (direct) return direct;
    if (!isChatGuid(id)) return undefined;
    for (const c of this.s.chatsByGuid.values()) if (sameChatGuid(c.chatId, id)) return c;
    return undefined;
  }
  /** chat() with its chat.db row id. */
  chatRec(id: string): ChatRec | undefined {
    return this.chat(id) as ChatRec | undefined;
  }
  /** A sender the directory doesn't know (a handle with no row, a hidden person) is "Unknown". */
  personName(id: string): string {
    return personDisplayName(id, this.s.peopleById.get(id), 'Unknown');
  }
  chatTitle(c: Chat): string {
    return chatTitle(this, c);
  }

  /** The person behind a handle row id, if any. */
  personOfHandle(handleRowid: unknown): string | undefined {
    return this.s.personIdByKey.get(this.s.handleKeyByRowid.get(Number(handleRowid)) ?? '');
  }

  /** Who sent a message row: the owner, the person behind its handle, the other side of a 1:1, or 'unknown'. */
  senderOf(r: Pick<MsgRow, 'is_from_me' | 'handle_id'>, chat?: ChatRec): string {
    if (r.is_from_me) return ME;
    const k = this.s.handleKeyByRowid.get(Number(r.handle_id));
    const pid = k ? this.s.personIdByKey.get(k) : undefined;
    if (pid) return pid;
    if (chat?.type === 'dm' && chat.participantIds[0]) return chat.participantIds[0];
    return 'unknown';
  }

  /** Every handle row id of a person. */
  personHandleRowids(pid: string): number[] {
    const p = this.s.peopleById.get(pid);
    return p ? p.handles.flatMap((h) => this.s.handleRowidsByKey.get(h.address) ?? []) : [];
  }

  /** The chat row ids a filter's chat conditions allow, or null when it has none. */
  visibleChatRowids(f: MessageFilter): number[] | null {
    let ids: number[] | null = null;
    const narrow = (next: number[]) => {
      ids = ids ? ids.filter((x) => next.includes(x)) : next;
    };
    if (f.chatIds) narrow(f.chatIds.map((g) => this.chatRec(g)?.rowid).filter((x): x is number => x !== undefined));
    if (f.withPersonId)
      narrow(
        [...this.s.chatsByRowid.values()].filter((c) => c.participantIds.includes(f.withPersonId!)).map((c) => c.rowid),
      );
    if (f.chatType || f.service)
      narrow(
        [...this.s.chatsByRowid.values()]
          .filter((c) => (!f.chatType || c.type === f.chatType) && (!f.service || c.service === f.service))
          .map((c) => c.rowid),
      );
    return ids;
  }

  /** The sender address redaction sees on display: the person's first handle, else the raw handle. */
  addressForIndex(handleRowid: number): string | undefined {
    const k = this.s.handleKeyByRowid.get(handleRowid);
    if (!k) return undefined;
    const pid = this.s.personIdByKey.get(k);
    return (pid ? this.s.peopleById.get(pid)?.handles[0]?.address : undefined) ?? k;
  }

  private read(): Snapshot {
    const book = loadContacts(this.cfg.addressBookDir);
    const handleKeyByRowid = new Map<number, string>();
    const handleRowidsByKey = new Map<string, number[]>();
    const servicesByKey = new Map<string, Set<Service>>();
    for (const h of this.db.prepare('select ROWID r, id, service from handle').all() as Row[]) {
      const k = handleKey(String(h.id));
      handleKeyByRowid.set(Number(h.r), k);
      getOrInit(handleRowidsByKey, k, () => []).push(Number(h.r));
      getOrInit(servicesByKey, k, () => new Set()).add(serviceOf(h.service));
    }
    const metaRows = this.side.db.prepare('select person_id, aliases, note, labels from person_meta').all() as Row[];
    const meta = new Map(metaRows.map((r) => [String(r.person_id), r]));
    const withMeta = (p: Person): Person => {
      const m = meta.get(p.personId);
      return m
        ? { ...p, aliases: JSON.parse(String(m.aliases)), note: optStr(m.note), labels: JSON.parse(String(m.labels)) }
        : p;
    };
    const peopleById = new Map<string, Person>();
    const personIdByKey = new Map<string, string>();
    for (const c of book.cards) {
      const id = `c_${hash(c.key)}`;
      const handles = [...c.handles].map((address) => ({
        address,
        services: [...(servicesByKey.get(address) ?? [])],
      }));
      peopleById.set(
        id,
        withMeta({
          personId: id,
          name: c.name,
          nicknames: c.nicknames,
          company: c.company,
          handles,
          aliases: [],
          labels: [],
        }),
      );
      for (const h of c.handles) if (book.byHandle.get(h) === c) personIdByKey.set(h, id);
    }
    for (const k of handleRowidsByKey.keys()) {
      if (personIdByKey.has(k)) continue;
      const id = `h_${/^\+?\d+$/.test(k) ? k.replace('+', '') : hash(k)}`;
      peopleById.set(
        id,
        withMeta({
          personId: id,
          name: null,
          nicknames: [],
          handles: [{ address: k, services: [...(servicesByKey.get(k) ?? [])] }],
          aliases: [],
          labels: [],
        }),
      );
      personIdByKey.set(k, id);
    }
    // Owner identity: me-card handles plus the accounts messages were sent from.
    const mine = new Set(book.meHandles);
    for (const r of this.db
      .prepare(
        `select distinct account a from message where is_from_me = 1 and account is not null and ROWID > (select max(ROWID) - 20000 from message)`,
      )
      .all() as Row[]) {
      const a = String(r.a).replace(/^[a-zA-Z]:/, '');
      if (a) mine.add(handleKey(a));
    }
    const me = { name: book.meName ?? 'Me', handles: [...mine] };
    // Hidden people and chats from config.
    const hiddenKeys = new Set<string>();
    const hideChats = new Set<string>();
    for (const h of this.cfg.hide) {
      const hiddenSuffix = chatGuidSuffix(h);
      if (hiddenSuffix !== undefined) {
        hideChats.add(hiddenSuffix);
        continue;
      }
      const k = handleKey(h);
      if (handleRowidsByKey.has(k) || personIdByKey.has(k)) {
        hiddenKeys.add(k);
        continue;
      }
      for (const p of peopleById.values())
        if (
          (p.name ?? '').toLowerCase() === h.toLowerCase() ||
          p.nicknames.some((n) => n.toLowerCase() === h.toLowerCase())
        )
          for (const ha of p.handles) hiddenKeys.add(ha.address);
    }
    const hiddenPeople = new Set([...hiddenKeys].map((k) => personIdByKey.get(k)).filter(Boolean) as string[]);
    for (const id of hiddenPeople) peopleById.delete(id);
    // Chats.
    const parts = new Map<number, number[]>();
    for (const r of this.db.prepare('select chat_id c, handle_id h from chat_handle_join').all() as Row[])
      getOrInit(parts, Number(r.c), () => []).push(Number(r.h));
    const labels = new Map<string, string[]>();
    for (const r of this.side.db.prepare('select chat_id, label from chat_labels').all() as Row[])
      getOrInit(labels, String(r.chat_id), () => []).push(String(r.label));
    const chatsByGuid = new Map<string, ChatRec>();
    const chatsByRowid = new Map<number, ChatRec>();
    const hiddenChatRowids = new Set<number>();
    for (const r of this.db
      .prepare('select ROWID r, guid, style, display_name, service_name, chat_identifier from chat')
      .all() as Row[]) {
      const rowid = Number(r.r);
      const type = Number(r.style) === CHAT_STYLE_GROUP ? 'group' : 'dm';
      let pids = [
        ...new Set(
          (parts.get(rowid) ?? []).map((h) => personIdByKey.get(handleKeyByRowid.get(h) ?? '') ?? '').filter(Boolean),
        ),
      ];
      if (type === 'dm' && !pids.length && r.chat_identifier) {
        const pid = personIdByKey.get(handleKey(String(r.chat_identifier)));
        if (pid) pids = [pid];
      }
      const guid = String(r.guid);
      const suffix = chatGuidSuffix(guid);
      const keys = (parts.get(rowid) ?? []).map((h) => handleKeyByRowid.get(h) ?? '');
      if (
        (suffix !== undefined && hideChats.has(suffix)) ||
        keys.some((k) => hiddenKeys.has(k)) ||
        (type === 'dm' && r.chat_identifier && hiddenKeys.has(handleKey(String(r.chat_identifier))))
      ) {
        hiddenChatRowids.add(rowid);
        continue;
      }
      const chat: ChatRec = {
        rowid,
        chatId: guid,
        type,
        service: serviceOf(r.service_name),
        displayName: r.display_name ? String(r.display_name) : null,
        participantIds: pids,
        createdAt: 0,
        labels: labels.get(guid) ?? [],
      };
      chatsByGuid.set(guid, chat);
      chatsByRowid.set(rowid, chat);
    }
    // Earlier group names from rename events, newest first, so an old name still finds the group.
    for (const r of this.db
      .prepare(`select cmj.chat_id c, m.group_title t from message m join chat_message_join cmj on cmj.message_id = m.ROWID
      where m.item_type = 2 and m.group_title is not null and m.group_title <> '' group by cmj.chat_id, m.group_title order by max(m.date) desc`)
      .all() as Row[]) {
      const chat = chatsByRowid.get(Number(r.c));
      const t = String(r.t);
      if (chat?.type !== 'group' || t === chat.displayName) continue;
      const list = chat.formerTitles ?? (chat.formerTitles = []);
      if (list.length < 5 && !list.includes(t)) list.push(t);
    }
    return {
      handleKeyByRowid,
      handleRowidsByKey,
      peopleById,
      personIdByKey,
      chatsByGuid,
      chatsByRowid,
      hiddenChatRowids,
      me,
    };
  }
}
