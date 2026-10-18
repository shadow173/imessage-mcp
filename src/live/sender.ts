import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BridgeConfig } from '../config.js';
import { chatGuidIdentifier, dmChatGuid } from '../domain/chatGuid.js';
import { effectAppleId } from '../domain/effects.js';
import { isShortCode, normalizeAddress } from '../lib/address.js';
import { ToolError } from '../lib/errors.js';
import { verifyFileLink } from '../links.js';
import {
  type IdempotencyRow,
  IN_FLIGHT_SENDS as IN_FLIGHT,
  idempotencyConflict,
  inProgressError,
  interruptedSend,
  isPendingSend,
  type PendingSend,
  type StoredSend,
  sendFingerprint,
} from '../store/idempotency.js';
import type { MessageStore } from '../store/ports.js';
import type { OutgoingAttachment, SendAttachmentResult, SendExtras, SendResult, Service } from '../store/types.js';
import { DOWNLOAD_FIX, type Downloader, downloadError, downloadPublic, MAX_STAGE_BYTES } from './download.js';
import { childEnv, OSA_NO_SUCH_OBJECT, OSA_NOT_AUTHORIZED_RE } from './macos.js';
import type { PrivateActions } from './privateActions.js';
import type { Sidecar } from './sidecar.js';
import { cleanText, decodeAttributedBody } from './typedstream.js';

/**
 * Arguments go in through `on run argv`, never by string interpolation, so message text can't inject script.
 * 1:1 chats go by participant (macOS 26 rejects `chat id "any;-;…"`); groups go by chat id.
 */
export const SEND_TO_PARTICIPANT = `on run argv
  set theText to item 1 of argv
  set theAddr to item 2 of argv
  set svcType to item 3 of argv
  set theFile to item 4 of argv
  tell application "Messages"
    if svcType is "SMS" then
      set acct to 1st account whose service type = SMS
    else
      set acct to 1st account whose service type = iMessage
    end if
    set p to participant theAddr of acct
    if theText is not "" then send theText to p
    if theFile is not "" then send (POSIX file theFile) to p
  end tell
end run`;

export const SEND_TO_CHAT = `on run argv
  set theText to item 1 of argv
  set theChat to item 2 of argv
  set theFile to item 4 of argv
  tell application "Messages"
    set c to chat id theChat
    if theText is not "" then send theText to c
    if theFile is not "" then send (POSIX file theFile) to c
  end tell
end run`;

export type ScriptRunner = (script: string, args: string[]) => Promise<void>;
type ScriptFailure = Error & { killed?: boolean; code?: unknown };

export const osascript: ScriptRunner = (script, args) =>
  new Promise((resolve, reject) => {
    const child = execFile('osascript', ['-', ...args], { timeout: 30_000, env: childEnv() }, (err, _out, stderr) => {
      if (err)
        reject(
          Object.assign(new Error(String(stderr || err.message).trim()), {
            stderr: String(stderr),
            killed: err.killed,
            code: err.code,
          }),
        );
      else resolve();
    });
    child.stdin?.end(script);
  });

/** Killed by the 30 s timeout or an AppleEvent timeout: Messages may still have sent it. */
const isTimeout = (e: ScriptFailure) => !!e.killed || /-1712|timed out/i.test(e.message);

type SendError = NonNullable<SendResult['error']>;

function scriptError(e: ScriptFailure, svcType: 'iMessage' | 'SMS'): SendError {
  const m = e.message;
  if (OSA_NOT_AUTHORIZED_RE.test(m))
    return {
      code: 'automation_denied',
      message:
        'macOS has not allowed the bridge to control Messages. Approve the Automation prompt on the Mac (System Settings > Privacy & Security > Automation).',
      fix: 'Nothing was sent. Tell the user; once they approve it, call again with the same idempotency_key.',
    };
  const noSuchObject = m.includes(String(OSA_NO_SUCH_OBJECT));
  if (noSuchObject && (/account/i.test(m) || svcType === 'SMS'))
    return {
      code: 'sms_unavailable',
      message: "This Mac couldn't send by SMS. Text Message Forwarding is probably off, or no iPhone is linked.",
      fix: 'Nothing was sent. Tell the user: on the iPhone, Settings > Messages > Text Message Forwarding must include this Mac. If the recipient has iMessage, retry with service=imessage.',
    };
  if (noSuchObject || /Can.t get/i.test(m))
    return {
      code: 'recipient_not_found',
      message: 'Messages could not find that conversation or recipient.',
      fix: 'Nothing was sent. Check the recipient with find, or ask the user for the number or email.',
    };
  if (/-1708|-1719|-1712|timed out/i.test(m))
    return {
      code: 'messages_unavailable',
      message: 'Messages did not respond. It may not be running or signed in.',
      fix: 'Tell the user Messages may need to be opened on the Mac, then retry with the same idempotency_key.',
    };
  return {
    code: 'applescript_error',
    message: m.slice(0, 300),
    fix: 'Nothing reached chat.db. Retry once with the same idempotency_key; if it fails again, tell the user.',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The name the file is staged under (and the transfer_name Messages records for it). '.' and '..' are not names. */
export const stagedName = (filename: string) => {
  const name = basename(filename).replace(/[^\w.\- ]/g, '_');
  return /^\.*$/.test(name) ? 'attachment' : name;
};

/** A row verify() matches a send against: the message, its chat and handle, and its first attachment's names. */
type SentRow = {
  r: number;
  text: string | null;
  body: Uint8Array | null;
  error: number;
  is_sent: number;
  is_delivered: number;
  att: number;
  c: number;
  hid: string | null;
  tn: string | null;
  fn: string | null;
};

/**
 * Sends through one store run one at a time, so verify() never claims rows another send wrote (two image.jpg sends to
 * the same chat).
 */
const sendQueues = new WeakMap<object, Promise<unknown>>();
function oneAtATime<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const next = (sendQueues.get(key) ?? Promise.resolve()).then(fn);
  sendQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

const RANK: Record<string, number> = { still_in_flight: 0, sent: 1, delivered: 2 };
const names = (xs: { filename: string }[]) => xs.map((x) => x.filename).join(', ');

/**
 * What sending needs from the live store: chat.db and the sidecar, lookups, the Private API for rich sends, and a
 * refresh once Messages has written the rows. LiveStore provides it.
 */
export interface SendDeps extends Pick<MessageStore, 'bootId' | 'attachment' | 'chat' | 'chatTitle' | 'message'> {
  readonly chatDb: DatabaseSync;
  readonly side: Sidecar;
  /** Absolute path of an attachment on disk. */
  attachmentPath(attachmentId: string): string | undefined;
  /** chat.db row id of a chat, if it is visible. */
  chatRowid(chatId: string): number | undefined;
  /** For sends with reply_to or an effect, through imsg. */
  privateCall: PrivateActions['privateCall'];
  /** chat.db guid of a message, for an inline reply. */
  guidOf(messageId: string): string;
  invalidateSummaries(): void;
  poll(): void;
  /** After a send to a new address: picks up the chat Messages just made. */
  refreshDirectory(): void;
}

export function createSender(
  store: SendDeps,
  cfg: BridgeConfig,
  run: ScriptRunner = osascript,
  verifyMs = 8000,
  download: Downloader = downloadPublic,
) {
  const db = store.chatDb;
  const side = store.side;
  const stageRoot = resolve(cfg.attachmentsStageDir);

  /** Removes a staged file's folder once Messages no longer needs it. */
  function unstage(file: string) {
    const dir = dirname(file);
    if (dirname(dir) !== stageRoot) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error('could not remove a staged attachment:', (e as Error).message);
    }
  }
  /** Whether Messages recorded the file at a path of its own, outside the stage folder (so the staged copy can go). */
  const copiedByMessages = (r: SentRow | null) => {
    if (!r?.fn) return false;
    const path = resolve(String(r.fn).replace(/^~(?=\/)/, process.env.HOME ?? homedir()));
    return !path.startsWith(`${stageRoot}/`);
  };

  /**
   * One of our own signed, unexpired /files/ links (any origin: only our LINK_SECRET can sign it): read the attachment
   * locally instead. An expired one is treated like any other URL.
   */
  function ownFileLink(url: string): string | undefined {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    const m = u.pathname.match(/^\/files\/([^/]+)$/);
    if (!m) return undefined;
    const id = decodeURIComponent(m[1]);
    const exp = u.searchParams.get('exp');
    return verifyFileLink(cfg.tools.linkSecret, id, exp, u.searchParams.get('sig'), Date.now()) ? id : undefined;
  }

  async function stage(a: OutgoingAttachment): Promise<string> {
    const sourceId = a.sourceAttachmentId ?? (a.url ? ownFileLink(a.url) : undefined);
    let data: Buffer | undefined;
    let src: string | undefined;
    if (sourceId) {
      if (!store.attachment(sourceId))
        throw new ToolError(
          'attachment_not_found',
          `No attachment has id "${sourceId}".`,
          'Use list_attachments or get_message to find attachment ids.',
        );
      src = store.attachmentPath(sourceId);
      if (!src || !existsSync(src))
        throw new ToolError(
          'attachment_not_downloaded',
          `${a.filename} isn't on this Mac (Messages keeps it in iCloud), so it can't be forwarded. Nothing was sent.`,
          'Tell the user. Opening the conversation in Messages on the Mac downloads it; then try again.',
        );
      if (statSync(src).size > MAX_STAGE_BYTES)
        throw new ToolError(
          'attachment_too_large',
          `${a.filename} is over 100 MB. Nothing was sent.`,
          'Tell the user; Messages may not send a file this large either.',
        );
    } else if (a.base64) data = Buffer.from(a.base64, 'base64');
    else if (a.url) {
      try {
        const r = await download(a.url, MAX_STAGE_BYTES);
        if (/text\/html/i.test(r.contentType ?? '') && !/html/i.test(a.mime))
          throw new ToolError(
            'attachment_download_failed',
            `Couldn't download ${a.filename}: the link returned a web page, not the file.`,
            DOWNLOAD_FIX,
          );
        data = r.data;
      } catch (e) {
        throw downloadError(a.filename, e);
      }
    } else
      throw new ToolError(
        'invalid_attachment',
        `${a.filename} needs attachment_id, base64 or url.`,
        'To forward a file already in Messages, pass its attachment_id.',
      );
    if (data && data.length > MAX_STAGE_BYTES)
      throw new ToolError(
        'attachment_too_large',
        `${a.filename} is over 100 MB. Nothing was sent.`,
        'Send a smaller file, or put a link to it in the text.',
      );
    const dir = join(stageRoot, randomUUID());
    mkdirSync(dir, { recursive: true });
    const file = join(dir, stagedName(a.filename));
    if (src) copyFileSync(src, file);
    else writeFileSync(file, data!);
    return file;
  }

  /**
   * Finds the rows Messages wrote for this send: the text row, then one row per file (matched by transfer_name, else
   * in order). macOS 26 can write an empty, unjoined "ghost" row; the chat join skips those. Each found row is then
   * followed until Messages marks it delivered or failed, within the same deadline.
   */
  async function verify(o: {
    after: number;
    text: string;
    chatRowid?: number;
    address?: string;
    files: string[];
    ms: number;
  }) {
    const want = cleanText(o.text);
    const deadline = Date.now() + o.ms;
    let textRow: SentRow | null = null;
    const fileRows: (SentRow | null)[] = o.files.map(() => null);
    const used = new Set<number>();
    const sameChat = (r: SentRow) =>
      o.chatRowid !== undefined
        ? Number(r.c) === o.chatRowid
        : o.address
          ? normalizeAddress(String(r.hid ?? '')) === o.address
          : true;
    while (Date.now() < deadline && ((want && !textRow) || fileRows.some((x) => !x))) {
      await sleep(350);
      const rows = db
        .prepare(`select m.ROWID r, m.text, m.attributedBody body, m.error, m.is_sent, m.is_delivered, m.cache_has_attachments att, cmj.chat_id c, h.id hid,
          (select a.transfer_name from message_attachment_join maj join attachment a on a.ROWID = maj.attachment_id where maj.message_id = m.ROWID limit 1) tn,
          (select a.filename from message_attachment_join maj join attachment a on a.ROWID = maj.attachment_id where maj.message_id = m.ROWID limit 1) fn
        from message m join chat_message_join cmj on cmj.message_id = m.ROWID left join handle h on h.ROWID = m.handle_id
        where m.ROWID > ? and m.is_from_me = 1 order by m.ROWID`)
        .all(o.after) as SentRow[];
      for (const r of rows) {
        if (used.has(Number(r.r)) || !sameChat(r)) continue;
        if (
          want &&
          !textRow &&
          cleanText(r.text != null ? String(r.text) : (decodeAttributedBody(r.body) ?? '')) === want
        ) {
          textRow = r;
          used.add(Number(r.r));
          continue;
        }
        if (!Number(r.att)) continue;
        let i = r.tn ? o.files.findIndex((f, j) => !fileRows[j] && f === String(r.tn)) : -1;
        if (i < 0) i = fileRows.findIndex((x) => !x);
        if (i >= 0) {
          fileRows[i] = r;
          used.add(Number(r.r));
        }
      }
    }
    const follow = async (r: SentRow | null) => {
      let cur = r;
      while (cur && !Number(cur.error) && !Number(cur.is_delivered) && Date.now() < deadline) {
        await sleep(300);
        cur = {
          ...cur,
          ...(db.prepare('select error, is_sent, is_delivered from message where ROWID = ?').get(cur.r) as Pick<
            SentRow,
            'error' | 'is_sent' | 'is_delivered'
          >),
        };
      }
      return cur;
    };
    const [text, ...files] = await Promise.all([follow(textRow), ...fileRows.map(follow)]);
    return { text, files };
  }

  /** markPending runs once everything is checked and staged, right before the first thing reaches Messages. */
  async function sendNow(
    target: { chatId?: string; address?: string },
    text: string,
    attachments: OutgoingAttachment[],
    service: Service | 'auto',
    extras: SendExtras,
    markPending: () => void,
  ): Promise<SendResult> {
    const chat = target.chatId ? store.chat(target.chatId) : undefined;
    if (target.chatId && !chat && !target.address)
      throw new ToolError(
        'chat_not_found',
        `No conversation has chat_id "${target.chatId}".`,
        'Use find or list_conversations to get a valid chat_id.',
      );
    let script: string,
      addr = '',
      svcType: 'iMessage' | 'SMS' = 'iMessage',
      byAddress = !chat;
    if (chat?.type === 'group') {
      script = SEND_TO_CHAT;
      addr = chat.chatId;
    } else {
      script = SEND_TO_PARTICIPANT;
      const raw = chat ? chatGuidIdentifier(chat.chatId) : (target.address ?? '');
      addr = normalizeAddress(raw) ?? raw;
      const svc = service === 'auto' ? (chat?.service ?? (isShortCode(addr) ? 'SMS' : 'iMessage')) : service;
      svcType = svc === 'iMessage' ? 'iMessage' : 'SMS';
      // Another service's thread with the same address may be a different chat row, so verify by address.
      if (chat && service !== 'auto' && service !== chat.service) byAddress = true;
    }
    if (!addr)
      throw new ToolError(
        'invalid_recipient',
        'No recipient address.',
        'Pass a chat_id, person, phone number or email in to.',
      );
    const rich = !!(extras.replyTo || extras.effect);
    const replyTo = extras.replyTo?.replace(/^#/, '');
    // Checked before anything is staged or sent.
    if (rich && !chat)
      throw new ToolError(
        'needs_existing_chat',
        'Inline replies and effects need an existing conversation.',
        'Send a plain message first, or drop reply_to/effect.',
      );
    if (rich && !text.trim())
      throw new ToolError(
        'needs_text',
        'Inline replies and effects need text.',
        'Add text, or drop reply_to/effect and send the attachment on its own.',
      );
    if (replyTo) {
      const orig = store.message(replyTo);
      if (!orig)
        throw new ToolError(
          'message_not_found',
          `No message has id "${replyTo}".`,
          'Use a message_id from read_conversation or search_messages.',
        );
      if (orig.chatId !== chat!.chatId)
        throw new ToolError(
          'reply_to_wrong_chat',
          `#${replyTo} is in a different conversation (chat_id ${orig.chatId}). Nothing was sent.`,
          `An inline reply goes to the conversation the message is in. Send to chat_id ${orig.chatId}, or drop reply_to.`,
        );
    }
    const staged: string[] = [];
    try {
      for (const a of attachments) staged.push(await stage(a));
    } catch (e) {
      for (const f of staged) unstage(f);
      throw e;
    }
    markPending();

    const before = Number((db.prepare('select max(ROWID) r from message').get() as { r: number }).r ?? 0);
    const chatRowid = chat && !byAddress ? store.chatRowid(chat.chatId) : undefined;
    const address = byAddress ? addr : undefined;
    const fallbackChatId = chat?.chatId ?? dmChatGuid(addr);
    const wantText = rich || !!text.trim();

    // 1. The text (or the rich send, through imsg's helper: AppleScript can do neither replies nor effects).
    let textErr: SendError | undefined,
      textTimedOut = false;
    if (wantText) {
      try {
        if (rich) {
          try {
            await store.privateCall('send.rich', {
              chat_guid: chat!.chatId,
              text,
              ...(replyTo ? { reply_to: store.guidOf(replyTo) } : {}),
              ...(extras.effect && effectAppleId(extras.effect) ? { effect_id: effectAppleId(extras.effect) } : {}),
            });
          } catch (e) {
            if (!(e instanceof ToolError) || e.code !== 'outcome_unknown') throw e;
          }
        } else await run(script, [text, addr, svcType, '']);
      } catch (e) {
        if (e instanceof ToolError) {
          for (const f of staged) unstage(f); // the files never go without the text
          throw e;
        }
        textErr = scriptError(e as ScriptFailure, svcType);
        textTimedOut = isTimeout(e as ScriptFailure);
      }
    }
    if (textErr) {
      // The files stay unsent: sending them without the text would make a partial message.
      for (const f of staged) unstage(f);
      const seen = textTimedOut
        ? null
        : (await verify({ after: before, text, chatRowid, address, files: [], ms: Math.min(2000, verifyMs) })).text;
      const notSent: SendAttachmentResult[] = attachments.map((a) => ({
        filename: a.filename,
        messageId: null,
        status: 'failed',
        error: 'not_sent',
      }));
      if (!textTimedOut && !seen)
        return {
          disposition: 'failed',
          chatId: fallbackChatId,
          retrySafe: true,
          error: textErr,
          ...(notSent.length ? { attachments: notSent } : {}),
        };
      if (seen) {
        store.invalidateSummaries();
        store.poll();
      }
      return {
        disposition: 'may_have_completed',
        chatId: fallbackChatId,
        message: seen ? store.message(`m${seen.r}`) : undefined,
        retrySafe: false,
        error: {
          code: 'outcome_unknown',
          message: seen
            ? `Messages reported an error (${textErr.message}), but the message appeared in chat.db.`
            : 'Messages timed out while sending, so it may or may not have gone out.',
          fix: "Check read_conversation before doing anything else. Don't resend it with a new idempotency_key unless the check shows it is missing and the user agrees.",
        },
        ...(notSent.length ? { attachments: notSent } : {}),
      };
    }

    // 2. Each file as its own send, the way Messages does it. One failing file doesn't stop the others.
    const files = staged.map((path, i) => ({
      path,
      filename: attachments[i].filename,
      accepted: false,
      error: undefined as SendError | undefined,
    }));
    for (const f of files) {
      try {
        await run(script, ['', addr, svcType, f.path]);
        f.accepted = true;
      } catch (e) {
        f.error = scriptError(e as ScriptFailure, svcType);
        f.accepted = isTimeout(e as ScriptFailure);
      }
    }

    // 3. Confirm in chat.db: the text row and one row per accepted file.
    const accepted = files.filter((f) => f.accepted);
    const perFile = Math.min(4000, verifyMs / 2);
    const v = await verify({
      after: before,
      text: wantText ? text : '',
      chatRowid,
      address,
      files: accepted.map((f) => basename(f.path)),
      ms: Math.min(verifyMs + perFile * accepted.length, Math.max(verifyMs, 20_000)),
    });
    // A file Messages refused, or one it copied into its own folder, is no longer needed in the stage folder.
    // Anything else (unconfirmed, or recorded at the staged path) is left for the age-based sweep.
    for (const f of files) if (!f.accepted || copiedByMessages(v.files[accepted.indexOf(f)] ?? null)) unstage(f.path);
    const fileResults: SendAttachmentResult[] = files.map((f) => {
      const row = f.accepted ? v.files[accepted.indexOf(f)] : null;
      if (!row)
        return f.accepted
          ? { filename: f.filename, messageId: null, status: 'unconfirmed' }
          : { filename: f.filename, messageId: null, status: 'failed', error: f.error?.code };
      if (Number(row.error))
        return { filename: f.filename, messageId: `m${row.r}`, status: 'failed', error: `messages_error_${row.error}` };
      return {
        filename: f.filename,
        messageId: `m${row.r}`,
        status: Number(row.is_delivered) ? 'delivered' : Number(row.is_sent) ? 'sent' : 'unconfirmed',
      };
    });
    const textRow = v.text;
    const mainRow = textRow ?? v.files.find((r) => r) ?? null;
    // Feed the store now so the result's updates cursor can skip this send's own events.
    if (mainRow) {
      store.invalidateSummaries();
      if (byAddress) store.refreshDirectory();
      store.poll();
    }
    const message = mainRow ? store.message(`m${mainRow.r}`) : undefined;
    const chatId = message?.chatId ?? fallbackChatId;
    const textOk = !!textRow && !Number(textRow.error);
    const out = fileResults.filter((f) => f.status === 'delivered' || f.status === 'sent');
    const bad = fileResults.filter((f) => f.status === 'failed');
    const unknown = fileResults.filter((f) => f.status === 'unconfirmed');
    const withFiles = (r: SendResult): SendResult => (attachments.length ? { ...r, attachments: fileResults } : r);
    const notDelivered = (code: number): SendError => ({
      code: 'not_delivered',
      message: `Messages reported error ${code}.`,
      fix:
        chat?.type !== 'group' && svcType === 'iMessage' && addr.startsWith('+')
          ? 'The number may not have iMessage. Ask the user, then retry with service=sms and a new idempotency_key.'
          : 'Nothing was delivered. Tell the user, or retry once with the same idempotency_key.',
    });

    const anythingOut = textOk || out.length > 0;
    const maybeOut = (wantText && !textRow) || unknown.length > 0;
    if (!anythingOut && !maybeOut) {
      const firstBad = bad[0] ? files.find((f) => f.filename === bad[0].filename)?.error : undefined;
      const error = textRow
        ? notDelivered(Number(textRow.error))
        : (firstBad ?? {
            code: 'not_delivered',
            message: `${bad[0]?.filename ?? 'The message'} was not delivered.`,
            fix: 'Nothing was delivered. Tell the user, or retry once with the same idempotency_key.',
          });
      return withFiles({ disposition: 'failed', chatId, message, retrySafe: true, error });
    }
    if (!anythingOut) {
      return withFiles({
        disposition: 'may_have_completed',
        chatId,
        message,
        retrySafe: false,
        error: {
          code: 'unconfirmed',
          message: `Messages accepted the send but no matching message appeared in chat.db within ${Math.round(verifyMs / 1000)} seconds.`,
          fix: 'Check read_conversation first. If it is missing there, ask the user before sending it again.',
        },
      });
    }
    const sentPart = wantText && textOk ? 'The text' : names(out);
    if (wantText && !textOk) {
      return withFiles({
        disposition: 'may_have_completed',
        chatId,
        message,
        retrySafe: false,
        error: textRow
          ? {
              code: 'not_delivered',
              message: `The text was not delivered (Messages error ${textRow.error}), but ${names(out)} went out.`,
              fix: 'Do not resend the files. Check read_conversation, then send only the text with a new idempotency_key if the user agrees.',
            }
          : {
              code: 'unconfirmed',
              message: `${names(out)} went out, but the text did not show up in chat.db.`,
              fix: 'Check read_conversation; if the text is missing, send only the text with a new idempotency_key. Do not resend the files.',
            },
      });
    }
    if (bad.length) {
      return withFiles({
        disposition: 'may_have_completed',
        chatId,
        message,
        retrySafe: false,
        error: {
          code: 'attachment_failed',
          message: `${sentPart} went out, but ${names(bad)} failed.`,
          fix: 'Do not resend the text. Check read_conversation, then send only the missing file(s) with a new idempotency_key.',
        },
      });
    }
    if (unknown.length) {
      return withFiles({
        disposition: 'may_have_completed',
        chatId,
        message,
        retrySafe: false,
        error: {
          code: 'attachment_unconfirmed',
          message: `${sentPart} went out, but ${names(unknown)} did not show up in chat.db in time.`,
          fix: 'Check read_conversation before doing anything; if a file is missing, send only that file with a new idempotency_key. Do not resend the text.',
        },
      });
    }
    const statuses = [
      ...(textRow
        ? [Number(textRow.is_delivered) ? 'delivered' : Number(textRow.is_sent) ? 'sent' : 'still_in_flight']
        : []),
      ...out.map((f) => f.status),
    ];
    const disposition = statuses.reduce(
      (a, b) => (RANK[b] < RANK[a] ? b : a),
      'delivered',
    ) as SendResult['disposition'];
    return withFiles({ disposition, chatId, message, retrySafe: false });
  }

  return async function send(
    target: { chatId?: string; address?: string },
    text: string,
    attachments: OutgoingAttachment[],
    service: Service | 'auto',
    key: string,
    extras: SendExtras = {},
  ): Promise<SendResult> {
    const fp = sendFingerprint(store, target, text, attachments, extras);
    const save = (row: IdempotencyRow) =>
      side.db
        .prepare('insert or replace into idempotency(key, result, created_at) values (?, ?, ?)')
        .run(key, JSON.stringify(row), Date.now());
    const prior = side.db.prepare('select result from idempotency where key = ?').get(key) as
      | { result: string }
      | undefined;
    if (prior) {
      let p = JSON.parse(prior.result) as IdempotencyRow;
      if (isPendingSend(p)) {
        if (p.fp !== fp) throw idempotencyConflict(store, { disposition: 'may_have_completed', chatId: p.chatId });
        if (p.boot === store.bootId) throw inProgressError();
        // An earlier run of the bridge stopped mid-send: settle it as outcome unknown, for good.
        p = interruptedSend(p);
        save(p);
      }
      // A failure that was safe to retry is never replayed (older installs stored them): really retry, then overwrite.
      if (!(p.disposition === 'failed' && p.retrySafe)) {
        // Rows stored before fingerprints count as a match.
        if (p.fp && p.fp !== fp)
          throw idempotencyConflict(store, { disposition: p.disposition, chatId: p.chatId, messageId: p.messageId });
        return {
          disposition: p.disposition,
          chatId: p.chatId,
          message: p.messageId ? store.message(p.messageId) : undefined,
          error: p.error,
          retrySafe: p.retrySafe,
          replayed: true,
          ...(p.attachments ? { attachments: p.attachments } : {}),
        };
      }
    }
    // Reserved synchronously, before the first await, so a concurrent retry can't slip in.
    if (IN_FLIGHT.has(key)) throw inProgressError();
    IN_FLIGHT.add(key);
    try {
      // Durable before anything reaches Messages, so a crash mid-send is never retried as if nothing went out.
      let pendingSaved = false;
      const markPending = () => {
        const row: PendingSend = {
          pending: true,
          boot: store.bootId,
          startedAt: Date.now(),
          chatId: target.chatId ?? dmChatGuid(target.address ?? ''),
          fp,
        };
        save(row);
        pendingSaved = true;
      };
      let result: SendResult;
      try {
        result = await oneAtATime(store, () => sendNow(target, text, attachments, service, extras, markPending));
      } catch (e) {
        // A thrown error (bad recipient, a file that can't be staged, a rejected rich send) keeps nothing, as before.
        if (pendingSaved) side.db.prepare('delete from idempotency where key = ?').run(key);
        throw e;
      }
      if (!(result.disposition === 'failed' && result.retrySafe)) {
        const stored: StoredSend = {
          disposition: result.disposition,
          messageId: result.message?.messageId,
          chatId: result.chatId,
          error: result.error,
          retrySafe: result.retrySafe,
          ...(result.attachments ? { attachments: result.attachments } : {}),
          fp,
        };
        save(stored);
      } else side.db.prepare('delete from idempotency where key = ?').run(key);
      side.audit('send', result.chatId, {
        key,
        disposition: result.disposition,
        files: attachments.length,
        chars: text.length,
        error: result.error?.code,
      });
      return result;
    } finally {
      IN_FLIGHT.delete(key);
    }
  };
}
