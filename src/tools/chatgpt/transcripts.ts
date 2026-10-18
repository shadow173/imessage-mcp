// Transcripts for fetch and for the /view pages behind citation links.

import { senderLabels } from '../../domain/naming.js';
import { chatHeader, type RenderOpts, renderLine, UNTRUSTED_NOTICE } from '../../lib/format.js';
import type { MessageStore } from '../../store/ports.js';
import type { Message } from '../../store/types.js';
import type { Ctx } from '../context.js';
import { renderOpts } from '../results.js';

export const PAGE = 50;
export const AROUND = 5;

/** Deep research has no get_message: a cut-off line points at fetch msg:<id>. */
export const fetchLineOpts = (ctx: Ctx, m: Message): RenderOpts => ({
  ...renderOpts(ctx, 2000),
  moreHint: `fetch msg:${m.messageId} for all`,
});

/** The chat's latest messages (/view page). until drops anything sent after the link was made. */
export function chatTranscript(ctx: Ctx, store: MessageStore, chatId: string, last = PAGE, until?: number): string {
  const chat = store.chat(chatId)!;
  const labels = senderLabels(store, chat);
  const msgs = store.pageChat(chatId, until === undefined ? {} : { before: until + 1 }, {
    limit: last,
    anchor: 'end',
  }).items;
  return [
    chatHeader(store, chat),
    UNTRUSTED_NOTICE,
    ...msgs.map((m) => renderLine(store, m, labels, renderOpts(ctx, 2000))),
  ].join('\n');
}

export function aroundText(
  ctx: Ctx,
  store: MessageStore,
  id: string,
  around: number,
  until: number | undefined,
  forFetch: boolean,
): string {
  const m = store.message(id)!;
  const chat = store.chat(m.chatId)!;
  const labels = senderLabels(store, chat);
  const msgs = store
    .messagesAround(id, around, around, false)
    .filter((x) => x.messageId === id || until === undefined || x.sentAt <= until);
  return [
    chatHeader(store, chat),
    UNTRUSTED_NOTICE,
    ...msgs.map((x) =>
      x.messageId === id
        ? renderLine(store, x, labels, renderOpts(ctx, 20_000), '▶ ')
        : renderLine(store, x, labels, forFetch ? fetchLineOpts(ctx, x) : renderOpts(ctx, 2000), '  '),
    ),
  ].join('\n');
}

/** The message in full (marked ▶) with `around` messages on each side (/view page). */
export function messageTranscript(ctx: Ctx, store: MessageStore, id: string, around = AROUND, until?: number): string {
  return aroundText(ctx, store, id, around, until, false);
}
