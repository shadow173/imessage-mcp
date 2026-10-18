// chat.db message rows to Messages: text, edits and unsends, inline replies, link previews, attachments, bubble layout
// and tapbacks.

import { effectLabelForAppleId } from '../domain/effects.js';
import { chunks, getOrInit } from '../lib/collections.js';
import { ME, type Message, type Reaction } from '../store/types.js';
import { APPLE_EPOCH_MS } from './appleTime.js';
import type { AttachmentCatalog } from './attachmentCatalog.js';
import { parseBplist, plistDict, unarchive } from './bplist.js';
import type { LiveContext } from './context.js';
import type { Directory } from './directory.js';
import {
  ATTACHMENT_COLS,
  type AttachmentRow,
  fromDb,
  ITEM_AUDIO_KEPT,
  ITEM_GROUP_ACTION,
  ITEM_LOCATION,
  ITEM_MEMBERSHIP,
  ITEM_MESSAGE,
  ITEM_RENAME,
  type MsgRow,
  SHOWN_ATTACHMENT,
  SQL_MS,
  serviceOf,
  URL_BALLOON,
} from './sql.js';
import { decodeTapback, TAPBACK_SQL, tapbackCandidates, tapbackTarget } from './tapbacks.js';
import { cleanText, decodeAttributedBody } from './typedstream.js';

/** The bubbles of one message in on-screen order, which is the order tapback part indexes count in. */
interface Bubbles {
  layout: ('text' | 'file')[];
  /** App and link balloons are one bubble whatever they contain. */
  balloon: boolean;
}

/** A tapback row, as foldTapbacks reads it. */
type TapbackRow = { ag: string; t: number; e: string | null; handle_id: number; is_from_me: number; date_ms: number };

/** What decodeRows reads from the rows alone, before the follow-up lookups fill in the rest. */
interface Decoded {
  out: Message[];
  byGuid: Map<string, Message>;
  /** Inline-reply originator guid per message, resolved to a message id by attachReplyTargets. */
  threadGuids: Map<Message, string>;
  /** Row ids of link balloons, whose previews attachLinkPreviews reads. */
  linkRowids: number[];
  bubbles: Map<Message, Bubbles>;
}

const inList = (xs: unknown[]) => xs.map(() => '?').join(',');

/** A link balloon's archived preview (payload_data): its title and URL, where they are strings. Throws if unreadable. */
export function readRichLink(payload: Uint8Array): { title?: string; url?: string } {
  const v = plistDict(unarchive(parseBplist(payload)));
  const md = plistDict(v?.richLinkMetadata ?? v);
  return {
    title: typeof md?.title === 'string' ? md.title : undefined,
    url: typeof md?.URL === 'string' ? md.URL : typeof md?.originalURL === 'string' ? md.originalURL : undefined,
  };
}

/** The label for an app balloon's bundle id; undefined for plain messages and link previews. */
function appType(bundle: string | null): string | undefined {
  if (!bundle || bundle === URL_BALLOON) return undefined;
  if (bundle.includes('PeerPaymentMessagesExtension')) return 'Apple Cash';
  if (bundle.includes('com.apple.messages.Polls')) return 'Poll';
  if (bundle.includes('Handwriting')) return 'Handwritten message';
  if (bundle.includes('DigitalTouch')) return 'Digital Touch';
  if (bundle.includes('FindMy')) return 'Find My location';
  if (bundle.includes('SafetyMonitor')) return 'Check In';
  if (bundle.includes('gamecenter')) return 'Game invite';
  return 'App message';
}

export class Hydrator {
  constructor(
    private ctx: LiveContext,
    private catalog: AttachmentCatalog,
  ) {}

  /** MSG_COLS rows (plus chat_rowid) as Messages, in row order. light skips the tapbacks. */
  hydrate(rows: MsgRow[], opts: { light?: boolean } = {}): Message[] {
    if (!rows.length) return [];
    const d = this.decodeRows(rows);
    const byId = new Map(d.out.map((m) => [m.messageId, m]));
    this.attachReplyTargets(d.threadGuids);
    this.attachLinkPreviews(d.linkRowids, byId);
    this.attachAttachments(rows, byId);
    layoutBubbles(d.bubbles);
    if (opts.light) return d.out;
    this.foldTapbacks(d.byGuid);
    return d.out;
  }

  private decodeRows(rows: MsgRow[]): Decoded {
    const { dir } = this.ctx;
    const d: Decoded = { out: [], byGuid: new Map(), threadGuids: new Map(), linkRowids: [], bubbles: new Map() };
    for (const r of rows) {
      const chat = dir.chatsByRowid.get(Number(r.chat_rowid));
      const mine = !!r.is_from_me;
      const raw = r.text != null ? String(r.text) : (decodeAttributedBody(r.body) ?? '');
      const text = cleanText(raw);
      let unsent = false;
      let editHistory: { text: string; at: number }[] | undefined;
      if (r.summary && (r.edited_ms || !text)) {
        try {
          const info = plistDict(parseBplist(r.summary)) ?? {};
          if (Array.isArray(info.rp) && info.rp.length && !text) unsent = true;
          if (info.ec && typeof info.ec === 'object') {
            const entries = (Object.values(info.ec)[0] ?? []) as { t?: Buffer; d?: number }[];
            editHistory = entries.slice(0, -1).map((e) => ({
              text: cleanText(decodeAttributedBody(e.t) ?? ''),
              at: e.d ? APPLE_EPOCH_MS + e.d * 1000 : 0,
            }));
          }
        } catch {
          /* leave as-is */
        }
      }
      const itemType = Number(r.item_type);
      const system = itemType === ITEM_MESSAGE ? undefined : systemEvent(dir, r, itemType);
      const status = mine
        ? Number(r.error)
          ? 'failed'
          : chat?.type === 'dm' && r.read_ms
            ? 'read'
            : r.is_delivered
              ? 'delivered'
              : 'sent'
        : undefined;
      const senderAddress = mine ? undefined : dir.handleKeyByRowid.get(Number(r.handle_id));
      const effect = effectLabelForAppleId(r.expressive_send_style_id ?? '');
      const msg: Message = {
        messageId: `m${r.rowid}`,
        chatId: chat?.chatId ?? 'unknown',
        senderId: dir.senderOf(r, chat),
        ...(senderAddress ? { senderAddress } : {}),
        service: serviceOf(r.service),
        sentAt: fromDb(r.date_ms) ?? 0,
        text: unsent ? '' : text,
        isRead: mine ? true : !!r.is_read,
        reactions: [],
        attachmentIds: [],
        ...(mine
          ? { status, deliveredAt: fromDb(r.delivered_ms), readAt: chat?.type === 'dm' ? fromDb(r.read_ms) : undefined }
          : {}),
        ...(r.edited_ms && !unsent ? { editedAt: fromDb(r.edited_ms), editHistory } : {}),
        ...(unsent ? { unsent: true } : {}),
        ...(effect ? { effect } : {}),
        ...(appType(r.balloon_bundle_id) ? { appType: appType(r.balloon_bundle_id) } : {}),
        ...(system ? { system } : {}),
        ...(Number(r.error) ? { error: `error ${r.error}` } : {}),
      };
      if (r.thread_originator_guid) d.threadGuids.set(msg, String(r.thread_originator_guid));
      if (r.balloon_bundle_id === URL_BALLOON) d.linkRowids.push(Number(r.rowid));
      // Bubbles in on-screen order (the tapback part index): each non-blank text run and each attachment placeholder.
      if (itemType === ITEM_MESSAGE) {
        const layout: ('text' | 'file')[] = [];
        raw.split('￼').forEach((x, i, all) => {
          if (x.replace(/�/g, '').trim()) layout.push('text');
          if (i < all.length - 1) layout.push('file');
        });
        d.bubbles.set(msg, { layout, balloon: !!r.balloon_bundle_id });
      }
      d.byGuid.set(String(r.guid), msg);
      d.out.push(msg);
    }
    return d;
  }

  /** Inline replies: the originator's guid to its message id. */
  private attachReplyTargets(threadGuids: Map<Message, string>) {
    if (!threadGuids.size) return;
    const map = new Map<string, number>();
    for (const chunk of chunks([...new Set(threadGuids.values())], 500))
      for (const r of this.ctx.db
        .prepare(`select ROWID r, guid from message where guid in (${inList(chunk)})`)
        .all(...chunk) as { r: number; guid: string }[])
        map.set(String(r.guid), Number(r.r));
    for (const [m, g] of threadGuids) if (map.has(g)) m.replyToId = `m${map.get(g)}`;
  }

  /** Link balloons: the URL and, from the archived preview in payload_data, its title. */
  private attachLinkPreviews(linkRowids: number[], byId: Map<string, Message>) {
    for (const chunk of chunks(linkRowids, 500)) {
      for (const r of this.ctx.db
        .prepare(`select ROWID r, text, payload_data p from message where ROWID in (${inList(chunk)})`)
        .all(...chunk) as { r: number; text: string | null; p: Uint8Array | null }[]) {
        const m = byId.get(`m${r.r}`);
        if (!m) continue;
        let url = (String(r.text ?? m.text).match(/https?:\/\/\S+/) ?? [])[0] ?? '';
        let title = '';
        if (r.p) {
          try {
            const link = readRichLink(r.p);
            title = link.title ?? '';
            url ||= link.url ?? '';
          } catch {
            /* no preview */
          }
        }
        if (url) {
          let site = '';
          try {
            site = new URL(url).hostname.replace(/^www\./, '');
          } catch {
            /* bad url */
          }
          m.link = { url, title: title || site || url, site };
        }
      }
    }
  }

  /** The attachments Messages shows for each message, in their stored order. */
  private attachAttachments(rows: MsgRow[], byId: Map<string, Message>) {
    const withAtt = rows.filter((r) => r.cache_has_attachments).map((r) => Number(r.rowid));
    for (const chunk of chunks(withAtt, 500)) {
      const atts = this.ctx.db
        .prepare(`select ${ATTACHMENT_COLS}
        from message_attachment_join maj join attachment a on a.ROWID = maj.attachment_id join message m on m.ROWID = maj.message_id
        where maj.message_id in (${inList(chunk)}) and ${SHOWN_ATTACHMENT} order by maj.message_id, a.ROWID`)
        .all(...chunk) as AttachmentRow[];
      for (const a of atts) {
        const m = byId.get(`m${a.mid}`);
        if (!m) continue;
        const att = this.catalog.fromRow(a, m.chatId);
        m.attachmentIds.push(att.attachmentId);
      }
    }
  }

  /** Tapbacks folded onto their targets: one per person per part (Messages allows one tapback per bubble). */
  private foldTapbacks(byGuid: Map<string, Message>) {
    const { db, dir } = this.ctx;
    const cands: string[] = [];
    for (const [g, m] of byGuid) cands.push(...tapbackCandidates(g, m.partCount));
    const state = new Map<string, Map<string, Reaction>>();
    for (const chunk of chunks(cands, 900)) {
      const rs = db
        .prepare(`select associated_message_guid ag, associated_message_type t, associated_message_emoji e, handle_id, is_from_me, ${SQL_MS('date')} date_ms
        from message where associated_message_guid in (${inList(chunk)}) and ${TAPBACK_SQL()} order by date`)
        .all(...chunk) as TapbackRow[];
      for (const r of rs) {
        const tb = decodeTapback(Number(r.t));
        if (!tb) continue; // stickers
        const { kind } = tb;
        const { part, guid: target } = tapbackTarget(String(r.ag));
        const by = r.is_from_me
          ? ME
          : (dir.personIdByKey.get(dir.handleKeyByRowid.get(Number(r.handle_id)) ?? '') ?? 'unknown');
        const per = getOrInit(state, target, () => new Map<string, Reaction>());
        const key = `${by}:${part}`;
        if (tb.removed) {
          if (per.get(key)?.kind === kind) per.delete(key);
        } else
          per.set(key, {
            kind,
            by,
            at: fromDb(r.date_ms) ?? 0,
            ...(kind === 'emoji' && r.e ? { emoji: String(r.e) } : {}),
            ...(part ? { part } : {}),
          });
      }
    }
    for (const [g, per] of state) {
      const m = byGuid.get(g);
      if (m) m.reactions = [...per.values()];
    }
  }
}

/** partCount and parts from the bubble layout, once the attachments are known. */
function layoutBubbles(bubbles: Map<Message, Bubbles>) {
  for (const [m, b] of bubbles) {
    const runs = b.layout.filter((k) => k === 'text').length;
    m.partCount = b.balloon ? 1 : Math.max(1, runs + m.attachmentIds.length);
    // Placeholders map to attachments in order; when the counts disagree the order is unknown and parts stays unset.
    if (!b.balloon && m.partCount > 1 && b.layout.length - runs === m.attachmentIds.length) {
      let f = 0;
      m.parts = b.layout.map((k) =>
        k === 'text' ? { kind: 'text' as const } : { kind: 'file' as const, attachmentId: m.attachmentIds[f++] },
      );
    }
  }
}

/** What a group or conversation event row (item_type other than ITEM_MESSAGE) shows. */
function systemEvent(dir: Directory, r: MsgRow, itemType: number): NonNullable<Message['system']> {
  const other = dir.personIdByKey.get(dir.handleKeyByRowid.get(Number(r.other_handle)) ?? '');
  const otherName = other ? dir.personName(other) : 'someone';
  const action = Number(r.group_action_type);
  switch (itemType) {
    case ITEM_MEMBERSHIP:
      return action === 1
        ? { type: 'removed', detail: `removed ${otherName} from the conversation` }
        : { type: 'added', detail: `added ${otherName} to the conversation` };
    case ITEM_RENAME:
      return {
        type: 'renamed',
        detail: r.group_title ? `named the conversation "${r.group_title}"` : 'removed the conversation name',
        title: r.group_title ? String(r.group_title) : null,
      };
    case ITEM_GROUP_ACTION:
      if (action === 0) return { type: 'left', detail: 'left the conversation' };
      return { type: 'icon_changed', detail: action === 2 ? 'removed the group photo' : 'changed the group photo' };
    case ITEM_LOCATION:
      return { type: 'location_shared', detail: 'shared their location' };
    case ITEM_AUDIO_KEPT:
      return { type: 'audio_kept', detail: 'kept an audio message' };
    default:
      return { type: 'shareplay', detail: 'started SharePlay' };
  }
}
