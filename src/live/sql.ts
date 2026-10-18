// chat.db's columns and the SQL fragments the live store's queries are built from.

import type { SQLOutputValue } from 'node:sqlite';
import type { AttachmentKind } from '../domain/attachments.js';
import { ToolError } from '../lib/errors.js';
import { normDomain, queryTerms } from '../store/match.js';
import type { MessageFilter, Service } from '../store/types.js';
import { APPLE_EPOCH_MS, toAppleNs } from './appleTime.js';
import type { Directory } from './directory.js';

/**
 * A row as node:sqlite returns it: integers as numbers (bigints from a readBigInts statement), text as strings, blobs as
 * Uint8Array, NULL as null. Read values with Number() or String(), or the accessors below.
 */
export type Row = Record<string, SQLOutputValue>;
/** A nullable text column as a string, or undefined for NULL. */
export const optStr = (v: SQLOutputValue | undefined) => (v == null ? undefined : String(v));
/** A nullable integer column as a number, or undefined for NULL. */
export const optNum = (v: SQLOutputValue | undefined) => (v == null ? undefined : Number(v));

/** A date column as ms since 2001 (chat.db wrote seconds before High Sierra, nanoseconds since). */
export const SQL_MS = (col: string) =>
  `(CASE WHEN ${col} > 1000000000000 THEN ${col} / 1000000 WHEN ${col} > 0 THEN ${col} * 1000 ELSE 0 END)`;
/** An SQL_MS value as epoch ms; undefined for 0 or null (never set). */
export const fromDb = (v: number | bigint | null | undefined) => (v ? Number(v) + APPLE_EPOCH_MS : undefined);
/** message.service, handle.service or chat.service_name as a Service; anything unknown is iMessage. */
export const serviceOf = (v: unknown): Service => (v === 'SMS' ? 'SMS' : v === 'RCS' ? 'RCS' : 'iMessage');

export const URL_BALLOON = 'com.apple.messages.URLBalloonProvider';
/** chat.style for a group chat (1:1 chats are 45). */
export const CHAT_STYLE_GROUP = 43;

/** message.item_type: 0 is an ordinary message, the rest are events shown in the conversation. */
export const ITEM_MESSAGE = 0;
export const ITEM_MEMBERSHIP = 1; // group_action_type 0 added someone, 1 removed someone
export const ITEM_RENAME = 2;
export const ITEM_GROUP_ACTION = 3; // group_action_type 0 left, 1 changed the photo, 2 removed it
export const ITEM_LOCATION = 4;
export const ITEM_AUDIO_KEPT = 5;
export const ITEM_SHAREPLAY = 6;

/** "Real" message rows: not tapbacks, and (unless asked) not group events. */
export const REAL = (includeSystem = false) => `(m.associated_message_type IS NULL OR m.associated_message_type = 0)
  AND ${includeSystem ? `m.item_type BETWEEN ${ITEM_MESSAGE} AND ${ITEM_SHAREPLAY}` : `m.item_type = ${ITEM_MESSAGE}`}
  AND NOT (
    m.item_type = ${ITEM_MESSAGE} AND m.text IS NULL AND m.attributedBody IS NULL AND m.cache_has_attachments = 0
    AND m.balloon_bundle_id IS NULL AND m.date_edited = 0
  )`;

export const MSG_COLS = `m.ROWID rowid, m.guid, m.text, m.attributedBody body, m.handle_id, m.is_from_me, m.service,
  ${SQL_MS('m.date')} date_ms, ${SQL_MS('m.date_read')} read_ms, ${SQL_MS('m.date_delivered')} delivered_ms, ${SQL_MS('m.date_edited')} edited_ms,
  m.is_read, m.is_delivered, m.error, m.item_type, m.group_action_type, m.other_handle, m.group_title,
  m.balloon_bundle_id, m.expressive_send_style_id, m.thread_originator_guid, m.cache_has_attachments, m.message_summary_info summary, m.is_audio_message`;

/**
 * A MSG_COLS row plus the chat it was read with (`cmj.chat_id chat_rowid`). Integer columns chat.db gives a default are
 * numbers; the *_ms dates are 0 when unset.
 */
export type MsgRow = {
  rowid: number;
  guid: string;
  text: string | null;
  /** attributedBody: the typedstream-encoded text, newer messages' only copy of it. */
  body: Uint8Array | null;
  handle_id: number;
  is_from_me: number;
  service: string | null;
  date_ms: number;
  read_ms: number;
  delivered_ms: number;
  edited_ms: number;
  is_read: number;
  is_delivered: number;
  error: number;
  item_type: number;
  group_action_type: number;
  other_handle: number;
  group_title: string | null;
  balloon_bundle_id: string | null;
  expressive_send_style_id: string | null;
  thread_originator_guid: string | null;
  cache_has_attachments: number;
  /** message_summary_info: a binary plist with edit history and unsend markers. */
  summary: Uint8Array | null;
  is_audio_message: number;
  chat_rowid: number;
};

/** Joins each message to one chat (the lowest chat ROWID), for reads that list a message once. */
export const MIN_CHAT_JOIN = `JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  AND cmj.chat_id = (SELECT MIN(c2.chat_id) FROM chat_message_join c2 WHERE c2.message_id = m.ROWID)`;

/** Attachment columns for toAttachment(), from attachment a joined to its message m (maj: message_attachment_join). */
export const ATTACHMENT_COLS = `maj.message_id mid, a.ROWID r, a.filename, a.mime_type, a.uti, a.transfer_name, a.total_bytes,
  a.is_sticker, m.is_audio_message, m.is_from_me, m.handle_id, ${SQL_MS('m.date')} date_ms`;
/** An ATTACHMENT_COLS row; lookups and lists add the chat as chat_rowid. */
export type AttachmentRow = {
  mid: number;
  r: number;
  filename: string | null;
  mime_type: string | null;
  uti: string | null;
  transfer_name: string | null;
  total_bytes: number | null;
  is_sticker: number;
  is_audio_message: number;
  is_from_me: number;
  handle_id: number;
  date_ms: number;
  chat_rowid?: number;
};
/** Attachments Messages shows: not hidden, and not the payload files behind app balloons. */
export const SHOWN_ATTACHMENT =
  "a.hide_attachment = 0 AND coalesce(a.transfer_name, '') NOT LIKE '%.pluginPayloadAttachment'";
/** For aggregates: a plain join. A message can belong to more than one chat; aggregates count it once per chat. */
export const AGG_JOIN = 'JOIN chat_message_join cmj ON cmj.message_id = m.ROWID';

export const KIND_SQL: Record<AttachmentKind, string> = {
  image:
    "(a.is_sticker = 0 AND (a.mime_type LIKE 'image/%' OR a.uti LIKE '%image%' OR a.uti LIKE '%heic%' OR a.uti LIKE '%jpeg%' OR a.uti LIKE '%png%'))",
  video: "(a.mime_type LIKE 'video/%' OR a.uti LIKE '%movie%' OR a.uti LIKE '%video%')",
  audio: "(m.is_audio_message = 0 AND a.mime_type LIKE 'audio/%')",
  voice_memo: '(m.is_audio_message = 1)',
  pdf: "(a.mime_type = 'application/pdf' OR a.uti LIKE '%pdf%')",
  sticker: '(a.is_sticker = 1)',
  document: `(a.is_sticker = 0
    AND coalesce(a.mime_type, '') NOT LIKE 'image/%' AND coalesce(a.mime_type, '') NOT LIKE 'video/%'
    AND coalesce(a.mime_type, '') NOT LIKE 'audio/%' AND coalesce(a.mime_type, '') <> 'application/pdf')`,
};

/** A LIKE pattern matching s literally, for use with ESCAPE '\'. */
export const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** LIMIT and OFFSET are bound parameters, and checked here so no caller can pass SQL, NaN or a negative count. */
export function sqlCount(n: number, name: 'limit' | 'offset'): number {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new ToolError(
      'invalid_argument',
      `${name} must be a whole number, 0 or more.`,
      `Pass ${name} as an integer.`,
    );
  return n;
}

/** SQL conditions (joined with "and") and their bound parameters, in order. */
export interface Where {
  sql: string[];
  params: (string | number | bigint)[];
}

/** The columns a filter's shared conditions apply to: chat.db message rows, or the search index's msg_meta. */
interface ScopeCols {
  chat: string;
  fromMe: string;
  handle: string;
  date: string;
  /** A filter time (epoch ms) as the date column stores it. */
  at: (ms: number) => string | number | bigint;
}
/** message m joined to chat_message_join cmj. */
export const MESSAGE_SCOPE: ScopeCols = {
  chat: 'cmj.chat_id',
  fromMe: 'm.is_from_me',
  handle: 'm.handle_id',
  date: 'm.date',
  at: toAppleNs,
};
/** The search index's msg_meta mm, whose dates are epoch ms. */
export const INDEX_SCOPE: ScopeCols = {
  chat: 'mm.chat_rowid',
  fromMe: 'mm.from_me',
  handle: 'mm.handle_id',
  date: 'mm.date_ms',
  at: (ms) => ms,
};

/** `col not in (…)` for the chats HIDE removes, or '' when nothing is hidden. */
export function notHidden(dir: Directory, col = 'cmj.chat_id'): string {
  return dir.hiddenChatRowids.size ? `${col} not in (${[...dir.hiddenChatRowids].join(',')})` : '';
}

/**
 * The conditions every message query shares, appended to w: the chats the filter allows (never a hidden one), who sent
 * the message, and the time range.
 */
export function scopeWhere(
  dir: Directory,
  f: Pick<MessageFilter, 'chatIds' | 'withPersonId' | 'chatType' | 'service' | 'from' | 'after' | 'before'>,
  cols: ScopeCols,
  w: Where = { sql: [], params: [] },
): Where {
  const chats = dir.visibleChatRowids(f);
  if (chats) w.sql.push(chats.length ? `${cols.chat} in (${chats.join(',')})` : '0');
  const hidden = notHidden(dir, cols.chat);
  if (hidden) w.sql.push(hidden);
  if (f.from?.kind === 'me') w.sql.push(`${cols.fromMe} = 1`);
  if (f.from?.kind === 'others') w.sql.push(`${cols.fromMe} = 0`);
  if (f.from?.kind === 'person') {
    const hs = dir.personHandleRowids(f.from.personId);
    w.sql.push(hs.length ? `${cols.fromMe} = 0 and ${cols.handle} in (${hs.join(',')})` : '0');
  }
  if (f.after !== undefined) {
    w.sql.push(`${cols.date} >= ?`);
    w.params.push(cols.at(f.after));
  }
  if (f.before !== undefined) {
    w.sql.push(`${cols.date} < ?`);
    w.params.push(cols.at(f.before));
  }
  return w;
}

/** The where clause for chat.db message queries (m joined to cmj): scopeWhere plus attachment, link and unread. */
export function messageWhere(dir: Directory, f: MessageFilter): Where {
  const w = scopeWhere(dir, f, MESSAGE_SCOPE);
  if (f.hasAttachment !== undefined) w.sql.push(`m.cache_has_attachments = ${f.hasAttachment ? 1 : 0}`);
  if (f.attachmentKinds?.length)
    w.sql.push(
      `exists (select 1 from message_attachment_join maj join attachment a on a.ROWID = maj.attachment_id where maj.message_id = m.ROWID and (${f.attachmentKinds.map((k) => KIND_SQL[k]).join(' or ')}))`,
    );
  if (f.hasLink !== undefined)
    w.sql.push(
      f.hasLink ? `m.balloon_bundle_id = '${URL_BALLOON}'` : `coalesce(m.balloon_bundle_id, '') <> '${URL_BALLOON}'`,
    );
  // Link words can sit in the URL (text or attributedBody) or only in the preview title (payload_data).
  for (const t of f.linkQuery ? queryTerms(f.linkQuery) : []) {
    w.sql.push(
      `(coalesce(m.text, '') like ? escape '\\' or instr(lower(m.attributedBody), ?) > 0 or instr(lower(m.payload_data), ?) > 0)`,
    );
    w.params.push(`%${escLike(t)}%`, t, t);
  }
  const domain = f.linkDomain ? normDomain(f.linkDomain) : '';
  if (domain) {
    const hay = ["lower(coalesce(m.text, ''))", 'lower(m.attributedBody)', 'lower(m.payload_data)'];
    w.sql.push(`(${hay.flatMap((h) => [`instr(${h}, ?) > 0`, `instr(${h}, ?) > 0`]).join(' or ')})`);
    for (let i = 0; i < hay.length; i++) w.params.push(`://${domain}`, `.${domain}`);
  }
  if (f.unreadOnly) w.sql.push('m.is_read = 0 and m.is_from_me = 0');
  if (!w.sql.length) w.sql.push('1');
  return w;
}
