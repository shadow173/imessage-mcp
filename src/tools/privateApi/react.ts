import * as z from 'zod/v4';
import { ToolError } from '../../lib/errors.js';
import { REACTION_EMOJI, reactionGlyph } from '../../lib/format.js';
import { plural } from '../../lib/text.js';
import {
  CONFIRM_LIMIT,
  onSlot,
  requireAllowlisted,
  requireSendEnabled,
  reserveOutbound,
} from '../../policy/sendPolicy.js';
import { ME, type Message, type Reaction, type ReactionKind } from '../../store/types.js';
import { findMessage } from '../args.js';
import { defineTool, SENDS } from '../registry.js';
import { zOneOf } from '../schemas.js';
import { privateApiKit, RATE_FIX, SEND_OFF_FIX, UNCONFIRMED } from './common.js';

const KINDS = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'] as const;
type Kind = (typeof KINDS)[number];

/** Emoji (with and without the variation selector) and common words for each tapback. */
const KIND_ALIASES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(REACTION_EMOJI).flatMap(([k, e]) => [
      [e, k],
      [e.replace(/️/g, ''), k],
    ]),
  ),
  heart: 'love',
  loved: 'love',
  '♥️': 'love',
  thumbs_up: 'like',
  thumbsup: 'like',
  '+1': 'like',
  liked: 'like',
  thumbs_down: 'dislike',
  thumbsdown: 'dislike',
  '-1': 'dislike',
  disliked: 'dislike',
  haha: 'laugh',
  ha_ha: 'laugh',
  lol: 'laugh',
  laughed: 'laugh',
  '!!': 'emphasize',
  emphasis: 'emphasize',
  emphasized: 'emphasize',
  exclamation: 'emphasize',
  '?': 'question',
  questioned: 'question',
  '❔': 'question',
};

const glyph = (k: string) => REACTION_EMOJI[k] ?? k;

/** Bubbles on screen; partCount when the store knows it, else one per attachment plus one for text (a lower bound). */
const bubbleCount = (m: Message) => m.partCount ?? Math.max(1, m.attachmentIds.length + (m.text.trim() ? 1 : 0));

export const react = defineTool({
  name: 'react',
  tier: 'pa',
  title: 'React to a message',
  description: (cfg) => {
    const listOnly = cfg.sendAllowlist.mode === 'list';
    return [
      'Add or remove a tapback on one message: love ❤️, like 👍, dislike 👎, laugh 😂, emphasize ‼️ or question ❓.',
      "You have one tapback per bubble, so a new one replaces your earlier one, including an emoji tapback like 🔥 that this tool can't send back.",
      "If the message already shows a reaction from You and the user didn't ask to replace it, check with them first.",
      'To take yours back, pass remove=true and leave out reaction.',
      'In SMS chats the other person may get it as a text like Liked "…".',
      listOnly
        ? "Reacting in a chat with someone outside the owner's send allowlist isn't allowed."
        : "Reacting in a chat with someone outside the owner's send allowlist needs the user's confirmation.",
    ].join(' ');
  },
  inputSchema: {
    message_id: z
      .string()
      .describe('The message id from a transcript (#m1234) or search result (msg:m1234); either form works.'),
    reaction: zOneOf(KINDS, KIND_ALIASES)
      .optional()
      .describe(
        'love ❤️, like 👍, dislike 👎, laugh 😂, emphasize ‼️, question ❓. Required unless remove=true; when removing, leave it out to take back whatever tapback you left.',
      ),
    remove: z.boolean().default(false).describe('true takes back your tapback on that bubble.'),
    part: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        '0-based bubble index. The text and each attachment of a message are separate parts; get_message lists them when there is more than one.',
      ),
    user_confirmed: z
      .boolean()
      .optional()
      .describe(
        `Set true only after the user, in this conversation, approved this tapback for someone outside the allowlist. ${CONFIRM_LIMIT}`,
      ),
  },
  annotations: SENDS,
  handler: async (a, ctx) => {
    const { store, line, result } = privateApiKit(ctx);
    const m = findMessage(store, a.message_id);
    const id = m.messageId;
    if (m.system)
      throw new ToolError(
        'not_reactable',
        "That is a conversation event, not a message, so it can't take a tapback.",
        'Pass the message_id of a message line (one that shows who said what).',
      );
    if (m.unsent)
      throw new ToolError('unsent', "You can't react to an unsent message.", 'Pick another message, or leave it.');
    const count = bubbleCount(m);
    if (a.part >= count) {
      throw new ToolError(
        'part_out_of_range',
        `Message #${id} has ${plural(count, 'bubble')} (part${count > 1 ? `s 0–${count - 1}` : ' 0'}).`,
        count > 1
          ? `Pass part 0–${count - 1}; get_message lists which bubble is which under Bubbles.`
          : 'Omit part (it defaults to 0). A single text is one bubble even with line breaks.',
      );
    }
    if (!a.remove && !a.reaction)
      throw new ToolError(
        'missing_reaction',
        'Say which tapback to add.',
        'Pass reaction: love, like, dislike, laugh, emphasize or question. To take yours back, pass remove=true instead.',
      );
    requireSendEnabled(ctx, { fix: SEND_OFF_FIX });

    const chat = store.chat(m.chatId)!;
    const mineOnPart = (r: Reaction) => r.by === ME && (r.part ?? 0) === a.part;
    const prev = m.reactions.find(mineOnPart);
    const prevLabel = prev ? (prev.kind === 'emoji' ? (prev.emoji ?? 'emoji') : prev.kind) : null;
    const prevGlyph = prev ? reactionGlyph(prev) : '';
    const partTag = a.part > 0 || count > 1 ? ` · part ${a.part}` : '';
    const base = {
      message_id: id,
      chat_id: chat.chatId,
      chat_title: store.chatTitle(chat),
      part: a.part,
      retry_safe: false,
    };
    const noop = (note: string, reaction: string | null) =>
      result(`${note}\n${line(m)}`, {
        ...base,
        status: 'unchanged',
        reaction,
        previous: prevLabel,
        changed: false,
        confirmed: true,
      });

    let kind: Kind;
    let release = () => {};
    if (a.remove) {
      if (!prev) return noop(`You have no tapback on #${id}${partTag}; nothing was sent.`, a.reaction ?? null);
      if (prev.kind === 'emoji')
        throw new ToolError(
          'unsupported_reaction',
          `Your tapback on #${id} is the ${prevGlyph} emoji, which can only be removed in Messages.`,
          'Tell the user to remove it in Messages. Reacting with one of the six kinds replaces it.',
        );
      if (a.reaction && a.reaction !== prev.kind)
        throw new ToolError(
          'reaction_mismatch',
          `Your tapback on #${id} is ${prevGlyph} ${prev.kind}, not ${a.reaction}.`,
          `Pass reaction=${prev.kind} or leave reaction out.`,
        );
      kind = prev.kind as Kind;
    } else {
      kind = a.reaction as Kind;
      if (prev?.kind === kind) return noop(`Already ${glyph(kind)}; nothing sent.`, kind);
      requireAllowlisted(ctx, { chat }, a.user_confirmed, {
        what: chat.service === 'iMessage' ? 'a tapback' : 'a tapback (on SMS it arrives as a text)',
        retry: 'call react again with user_confirmed=true',
      });
      release = reserveOutbound(ctx, { fix: RATE_FIX });
    }

    // Removing a tapback isn't counted, so it reserves nothing.
    const after = await onSlot(release, () => store.react(id, kind as ReactionKind, undefined, a.remove, a.part));
    const now = after.reactions.find(mineOnPart);
    const confirmed = a.remove ? !now : now?.kind === kind;
    const status = !confirmed ? 'unconfirmed' : a.remove ? 'removed' : 'reacted';
    const summary = a.remove
      ? `Removed your ${glyph(kind)}.`
      : !prev
        ? `Added ${glyph(kind)}.`
        : prev.kind === 'emoji'
          ? `Replaced your ${prevGlyph} with ${glyph(kind)}; an emoji tapback can't be sent back from here.`
          : `Replaced your ${prevGlyph} with ${glyph(kind)}.`;
    const head = confirmed
      ? `${a.remove ? 'REMOVED' : 'REACTED'} ${kind} → ${store.chatTitle(chat)} · chat_id ${chat.chatId}${partTag}\n${summary}`
      : `NOT CONFIRMED YET → ${store.chatTitle(chat)} · chat_id ${chat.chatId}${partTag}\n${UNCONFIRMED}`;
    return result(`${head}\n${line(after)}`, {
      ...base,
      status,
      reaction: kind,
      previous: prevLabel,
      changed: confirmed,
      confirmed,
    });
  },
});
