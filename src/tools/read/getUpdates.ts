import * as z from 'zod/v4';
import { senderLabels } from '../../domain/naming.js';
import { decodeCursor, encodeCursor, zEpochMs } from '../../lib/cursor.js';
import { ToolError } from '../../lib/errors.js';
import { messageJson, messageText, REACTION_EMOJI, UNTRUSTED_NOTICE } from '../../lib/format.js';
import { MAX_UPDATE_HOLD_S } from '../../lib/limits.js';
import { resolveChatScope } from '../../lib/resolve.js';
import { foldBreaks } from '../../lib/text.js';
import { fmtIso, fmtShort } from '../../lib/time.js';
import { redact } from '../../policy/redact.js';
import { type Attachment, ME, type Message, type UpdateEvent } from '../../store/types.js';
import { parseFrom } from '../args.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult, renderOpts, textResult } from '../results.js';
import { zChatScopeOpt, zLimit, zList } from '../schemas.js';
import { fileTag, fromKey, readKit, UPDATE_TYPES, type UpdateType, UpFilter, zId } from './common.js';

const UP_FIX = [
  'Pass cursor="now" to start over, or next_cursor/updates_cursor exactly as returned.',
  'Times and message ids are not cursors; for history use read_conversation with after.',
].join(' ');

/**
 * get_updates and send_message's updates_cursor: the last seq covered, the store's boot id, when it was minted, and the
 * pinned filter.
 */
export const UpCursor = z.object({
  k: z.literal('up'),
  s: z.number().int().min(0),
  b: zId.optional(),
  t: zEpochMs.optional(),
  f: UpFilter.optional(),
});

export const getUpdates = defineTool({
  name: 'get_updates',
  tier: 'read',
  title: 'Get updates',
  description: [
    'Changes since your last call: new messages, edits, unsends, reactions, and delivery or read receipts.',
    'Start with cursor="now" (or send_message\'s updates_cursor), then pass back next_cursor each time. wait_seconds holds the call open until a matching change arrives. next_cursor covers everything up to that point, including events your filter skipped.',
    'You may change the filter on a cursor: a narrower one loses nothing, a different one rescans from the cursor (the result says filter_changed); never restart with cursor="now" just to change it, since that drops pending changes.',
    'If your call times out, repeat it with the same cursor; no events are lost.',
    'Each event says who caused it (by: the sender, reactor or reader) and carries the message in its current state; is_from_me says whether that message is yours.',
    'For "tell me when X replies": take updates_cursor from send_message (or cursor="now" before sending), then call with from=X and wait_seconds=50, repeating with next_cursor.',
    "You can't keep watching after your turn ends; if nothing arrives, tell the user and offer set_reminder.",
  ].join(' '),
  inputSchema: {
    cursor: z
      .string()
      .describe(
        '"now" to start, next_cursor from the previous call, or updates_cursor from send_message. Not a time or message id.',
      ),
    chat: zChatScopeOpt,
    from: z
      .string()
      .optional()
      .describe(
        'Only changes made by this sender: "me", "others", or a person (every handle and chat of theirs). With from and no types, only new messages.',
      ),
    types: zList(UPDATE_TYPES)
      .optional()
      .describe('Which kinds of change, one or a list. Default: all (only new when from is set).'),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(60)
      .default(0)
      .describe(
        'Held at most 50 s whatever you pass, to stay inside common client timeouts. Empty events means nothing happened; call again with next_cursor.',
      ),
    limit: zLimit(100, 500),
    format: z
      .enum(['json', 'transcript'])
      .default('json')
      .describe('json (default): structured events. transcript: one compact line per event.'),
  },
  annotations: READ_ONLY,
  handler: async (a, ctx) => {
    const { store, tz, chatTitleOf, fromLabel, narrowerOrSame, filterJson, refilterNote, expired } = readKit(ctx);
    const from = parseFrom(store, a.from);
    const fr = fromKey(from);
    const types: UpdateType[] | undefined = a.types?.length ? [...new Set(a.types)].sort() : from ? ['new'] : undefined;
    const scope = a.chat ? resolveChatScope(store, a.chat) : undefined;
    const chatIds = scope ? [...new Set(scope.chatIds)].sort() : undefined;
    const want: UpFilter | undefined =
      chatIds || types || fr
        ? {
            ...(chatIds ? { c: chatIds } : {}),
            ...(scope?.personId ? { p: scope.personId } : {}),
            ...(types ? { ty: types } : {}),
            ...(fr ? { fr } : {}),
          }
        : undefined;
    const raw = a.cursor.trim();
    const isNow = raw.toLowerCase() === 'now';
    let seq: number;
    let mintedAt: number | undefined;
    let pinned = false;
    let refiltered: UpFilter | undefined;
    if (isNow) seq = store.latestSeq();
    else {
      if (/^(?:null|undefined|none)?$/i.test(raw))
        throw new ToolError('invalid_cursor', `"${raw}" is not a cursor.`, UP_FIX);
      const c = decodeCursor(raw, UpCursor, UP_FIX);
      if (c.b !== store.bootId || c.s > store.latestSeq() || store.oldestSeq() > c.s + 1) throw expired(c.t);
      if (c.f) {
        // Same or narrower filter: everything the cursor skipped is outside it too, so it stays pinned. Wider or
        // different: rescan from the cursor without skipping (never an error: cursor="now" would lose what is
        // pending).
        if (narrowerOrSame(c.f, { chatIds, personId: scope?.personId, types, fr })) pinned = true;
        else refiltered = c.f;
      }
      seq = c.s;
      mintedAt = c.t;
    }
    const chatSet = chatIds ? new Set(chatIds) : undefined;
    const typeSet = types ? new Set(types) : undefined;
    const personDm = (chatId: string) => {
      const c = store.chat(chatId);
      return !!scope?.personId && !!c && c.type === 'dm' && c.participantIds[0] === scope.personId;
    };
    const actorOf = (e: UpdateEvent) =>
      e.actorId ??
      (e.type === 'new' || e.type === 'edited' || e.type === 'unsent'
        ? store.message(e.messageId)?.senderId
        : undefined);
    const match = (e: UpdateEvent) => {
      if (chatSet && !chatSet.has(e.chatId) && !personDm(e.chatId)) return false;
      if (typeSet && !typeSet.has(e.type)) return false;
      if (!from) return true;
      const actor = actorOf(e);
      return (
        actor !== undefined &&
        (from.kind === 'me' ? actor === ME : from.kind === 'others' ? actor !== ME : actor === from.personId)
      );
    };
    const holdMs = Math.min(a.wait_seconds, MAX_UPDATE_HOLD_S) * 1000;
    const started = Date.now();
    const deadline = started + holdMs;
    // Unmatched events (other chats, filtered types) don't end the hold: wait again from the newest seq.
    while (holdMs > 0 && !store.updatesSince(seq).some(match) && Date.now() < deadline)
      await store.waitForUpdate(store.latestSeq(), deadline - Date.now());
    const scanned = store.updatesSince(seq);
    const matched = scanned.filter(match);
    const events = matched.slice(0, a.limit);
    const more = matched.length > a.limit;
    const lastReturned = events[events.length - 1] as UpdateEvent | undefined;
    // Skip past unmatched events only on a cursor already pinned to this filter; the first filtered call pins it.
    const lastSeq = more
      ? lastReturned!.seq
      : pinned || !want
        ? scanned.length
          ? scanned[scanned.length - 1].seq
          : seq
        : (lastReturned?.seq ?? seq);
    const t = more || (want && !pinned) ? (lastReturned?.at ?? mintedAt ?? store.now()) : store.now();
    const nextCursor = encodeCursor({ k: 'up', s: lastSeq, b: store.bootId, t, ...(want ? { f: want } : {}) });
    const waited = Date.now() - started;
    const opts = renderOpts(ctx, 500);
    const prevText = (e: UpdateEvent, m: Message | undefined, o = opts) =>
      m
        ? messageText(store, { ...m, text: e.previousText!, unsent: false }, o)
        : redact(e.previousText!, undefined, ctx.cfg.redactCodes);
    if (a.format === 'transcript') {
      const short = { ...opts, maxChars: 120, moreHint: false as const };
      const line = (e: UpdateEvent) => {
        const m = store.message(e.messageId);
        const chat = store.chat(e.chatId);
        const labels = chat ? senderLabels(store, chat) : new Map<string, string>();
        const name = (id: string) => labels.get(id) ?? store.personName(id);
        const actor = actorOf(e);
        const r = e.reaction;
        const head =
          e.type === 'reaction' && r
            ? `${r.removed ? 'removed ' : ''}${r.kind === 'emoji' ? (r.emoji ?? '🙂') : REACTION_EMOJI[r.kind]} by ${actor ? name(actor) : 'someone'}`
            : (e.type === 'read' || e.type === 'delivered') && actor
              ? `${e.type} by ${name(actor)}`
              : e.type;
        let body = '';
        if (m) {
          const text = messageText(store, m, short);
          const files = m.unsent
            ? []
            : m.attachmentIds
                .map((id) => store.attachment(id))
                .filter((x): x is Attachment => !!x)
                .map((x) => `[${fileTag(x)}]`);
          const current = [text ? `"${foldBreaks(text)}"` : '', ...files].filter(Boolean).join(' ');
          const target = e.type === 'reaction' || e.type === 'read' || e.type === 'delivered' ? 'on ' : '';
          body = ` · ${target}${name(m.senderId)}: ${e.type === 'edited' && e.previousText !== undefined ? `"${foldBreaks(prevText(e, m, short))}" → ${current}` : current}`;
        }
        return foldBreaks(
          `[${fmtShort(e.at, tz, store.now())}] ${head} · ${chatTitleOf(e.chatId)}${body} #${e.messageId}`,
          ' ',
        );
      };
      const out = events.length
        ? [UNTRUSTED_NOTICE, ...events.map(line)]
        : [`No changes${waited >= 1000 ? ` in ${Math.round(waited / 1000)} s` : ''}.`];
      if (want)
        out.push(
          `Watching${chatIds ? ` chat_ids ${chatIds.join(', ')}` : ''}${types ? ` · types ${types.join(',')}` : ''}${from ? ` · from ${fromLabel(from)}` : ''}`,
        );
      if (refiltered) out.push(refilterNote(refiltered));
      if (more) out.push(`${matched.length - events.length} more · call again with next_cursor`);
      out.push(`next_cursor ${nextCursor}`);
      return textResult(out.join('\n'));
    }
    const eventJson = (e: UpdateEvent) => {
      const m = store.message(e.messageId);
      const actor = actorOf(e);
      const r = e.reaction;
      return {
        type: e.type,
        at: fmtIso(e.at, tz),
        chat_id: e.chatId,
        chat_title: chatTitleOf(e.chatId),
        ...(actor
          ? { by: actor === ME ? 'me' : store.personName(actor), ...(actor !== ME ? { by_person_id: actor } : {}) }
          : {}),
        is_from_me: m ? m.senderId === ME : actor === ME,
        ...(r
          ? { reaction: r.kind === 'emoji' ? (r.emoji ?? 'emoji') : r.kind, ...(r.removed ? { removed: true } : {}) }
          : {}),
        ...(e.type === 'edited' && e.previousText !== undefined ? { previous_text: prevText(e, m) } : {}),
        message: m ? messageJson(store, m, opts) : { message_id: e.messageId },
      };
    };
    return jsonResult(
      {
        events: events.map(eventJson),
        next_cursor: nextCursor,
        watching: {
          chat_ids: chatIds ?? null,
          types: types ?? null,
          from: fr ?? null,
          ...(from?.kind === 'person' ? { from_name: store.personName(from.personId) } : {}),
        },
        waited_ms: waited,
        ...(more ? { has_more: true } : {}),
        ...(isNow && holdMs === 0
          ? { note: 'Cursor set. Call again with next_cursor to receive changes from this point.' }
          : {}),
        ...(refiltered ? { filter_changed: { previous: filterJson(refiltered), note: refilterNote(refiltered) } } : {}),
      },
      { untrusted: events.length > 0 },
    );
  },
});
