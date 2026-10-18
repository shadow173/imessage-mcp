import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { senderLabels, shortName } from '../src/domain/naming.js';
import { ToolError } from '../src/lib/errors.js';
import {
  akaOf,
  attachmentFacts,
  chatHeader,
  chatJson,
  chatLine,
  extractedTextBlock,
  fmtBytes,
  isUnknownDm,
  messageJson,
  messageText,
  needsReplyTriage,
  REACTION_EMOJI,
  renderLine,
  UNTRUSTED_NOTICE,
} from '../src/lib/format.js';
import { fmtClock, fmtShort } from '../src/lib/time.js';
import { CODE_MARKER, redact } from '../src/policy/redact.js';
import type { MessageStore } from '../src/store/ports.js';
import { type Attachment, type Chat, ME, type Message } from '../src/store/types.js';
import { newMockStore } from './helpers/mock.js';

const SHORT = '28734';
const LONG = '+15555551234';
const ME_ = undefined; // from-me and handle-less senders pass no address
const H = '■'; // stands for CODE_MARKER in the expected column

/**
 * The one redaction table. [text, sender address, expected output].
 * Short codes hide every code shape; everyone else (known contacts and the owner too) only near a code word.
 */
const REDACTION: [string, string | undefined, string][] = [
  // comma after the code, PIN wording, enter-to-confirm, split codes
  [
    'Your verification code is 482913, it expires in 10 minutes',
    SHORT,
    `Your verification code is ${H}, it expires in 10 minutes`,
  ],
  [
    'Your verification code is 482913, it expires in 10 minutes',
    LONG,
    `Your verification code is ${H}, it expires in 10 minutes`,
  ],
  [
    'Your Chase verification code is 482913, valid for 10 minutes',
    LONG,
    `Your Chase verification code is ${H}, valid for 10 minutes`,
  ],
  ['Your login code is 482913, do not share', LONG, `Your login code is ${H}, do not share`],
  ['Code 482913,', SHORT, `Code ${H},`],
  ['Your PIN is 482913', LONG, `Your PIN is ${H}`],
  ['Your login PIN: 2041', LONG, `Your login PIN: ${H}`],
  ['Your PIN 4821 was reset', LONG, `Your PIN ${H} was reset`],
  ['Enter 482913 to confirm your WhatsApp account', LONG, `Enter ${H} to confirm your WhatsApp account`],
  ['Your code: 48 29 13', LONG, `Your code: ${H}`],
  ['Your code: 48 29 13', SHORT, `Your code: ${H}`],
  ['Use 4829-13 to log in', LONG, `Use ${H} to log in`],
  ['Please verify: 482913', LONG, `Please verify: ${H}`],
  [
    'Northwind Bank: Your verification code is 482913. It expires in 10 minutes.',
    SHORT,
    `Northwind Bank: Your verification code is ${H}. It expires in 10 minutes.`,
  ],
  ['Your Ridely code is 7731', '86753', `Your Ridely code is ${H}`],
  ['$1,250', SHORT, '$1,250'],
  ['12,500 points', SHORT, '12,500 points'],
  ['3.14159', SHORT, '3.14159'],
  ['Pinned the 2026 calendar', LONG, 'Pinned the 2026 calendar'],
  ['Can you pin the 2026 photo', LONG, 'Can you pin the 2026 photo'],
  ['pin the message about 2025 plans', LONG, 'pin the message about 2025 plans'],
  ['drop a pin at 1930', LONG, 'drop a pin at 1930'],
  ['confirm the 1500 order', LONG, 'confirm the 1500 order'],
  // dashed, spaced, NBSP and alphanumeric codes; money, phones and words-with-digits stay
  ['Your code: 482-913', SHORT, `Your code: ${H}`],
  ['Your code is 482 913', LONG, `Your code is ${H}`],
  ['Your code is 482\u00a0913', LONG, `Your code is ${H}`], // a no-break space between the halves
  ['WhatsApp code 482-913. Do not share', LONG, `WhatsApp code ${H}. Do not share`],
  ['482 913 is your Instagram code', LONG, `${H} is your Instagram code`],
  ['G-482913 is your Google verification code.', LONG, `G-${H} is your Google verification code.`],
  ['Your code is 7731, do not share', LONG, `Your code is ${H}, do not share`],
  ['Your code is 482913.', LONG, `Your code is ${H}.`],
  ['Use 4829-1300 to sign in', LONG, `Use ${H} to sign in`],
  ['Login code 1234 5678', LONG, `Login code ${H}`],
  ['Sign in code 482 913 expires at 10:45', LONG, `Sign in code ${H} expires at 10:45`],
  ['Your login code is AB12CD', LONG, `Your login code is ${H}`],
  ['Two-factor code: 33 44 55', LONG, `Two-factor code: ${H}`],
  ['Security alert: $2,350 charged.', SHORT, 'Security alert: $2,350 charged.'],
  ['1,250 points', SHORT, '1,250 points'],
  ['lockbox code is cabin2026', LONG, 'lockbox code is cabin2026'],
  ['Call 555-123-4567 for security help', SHORT, 'Call 555-123-4567 for security help'],
  ['(555) 123-4567 re: code review', LONG, '(555) 123-4567 re: code review'],
  ['code +1 555 123 4567', LONG, 'code +1 555 123 4567'],
  ['+44 20 7946 0958 is the code desk', LONG, '+44 20 7946 0958 is the code desk'],
  ['code 5551234567', LONG, 'code 5551234567'],
  ['4.5 stars, 12.50 code', LONG, '4.5 stars, 12.50 code'],
  ['3:30 pm code', LONG, '3:30 pm code'],
  // word boundaries, proximity, years, currency, phone numbers from short codes
  ["I'm signing the lease for 2027 tomorrow", ME_, "I'm signing the lease for 2027 tomorrow"],
  ['Security deposit is the same and rent is 2350 right?', ME_, 'Security deposit is the same and rent is 2350 right?'],
  ['designing the 2027 roadmap', ME_, 'designing the 2027 roadmap'],
  ['assigning seats for 2026', LONG, 'assigning seats for 2026'],
  ['one time in 2019', LONG, 'one time in 2019'],
  ['catalog in 2025', LONG, 'catalog in 2025'],
  ['See you in 2027!', LONG, 'See you in 2027!'],
  ['zip code is 10001', LONG, 'zip code is 10001'],
  ['Read the 2026 code of conduct', LONG, 'Read the 2026 code of conduct'],
  ['Your code expires 2026-10-17', LONG, 'Your code expires 2026-10-17'],
  ['code bonus 1500 points', LONG, 'code bonus 1500 points'],
  ['Call 1-800-555-1234 for help', '22000', 'Call 1-800-555-1234 for help'],
  [
    'Your verification code is 482913. Questions? Call 1-800-555-1234',
    SHORT,
    `Your verification code is ${H}. Questions? Call 1-800-555-1234`,
  ],
  [
    'Verification of your address is complete. Your order ships soon. Order number 482913',
    LONG,
    'Verification of your address is complete. Your order ships soon. Order number 482913',
  ],
  [
    'Verification of your address is complete. Your order ships soon. Order number 482913',
    SHORT,
    `Verification of your address is complete. Your order ships soon. Order number ${H}`,
  ],
  ['Your code is 2026', LONG, `Your code is ${H}`],
  ['2019 is your Lyft code', LONG, `${H} is your Lyft code`],
  // known miss, by design (codes are matched by proximity to a code word): a long-number code more than ~40 chars from
  // its code word stays visible
  [
    'Your code to verify your account is below. Thanks for joining us, have a great day.\n\n482913',
    LONG,
    'Your code to verify your account is below. Thanks for joining us, have a great day.\n\n482913',
  ],
  // ...unless a "do not share" phrase sits next to it
  [
    'Your code to verify your account is below. Do not share it with anyone.\n\n482913',
    LONG,
    `Your code to verify your account is below. Do not share it with anyone.\n\n${H}`,
  ],
  // a year from a short code stays visible when no code word is near; with one, it is the code
  ['Your statement for 2026 is ready', SHORT, 'Your statement for 2026 is ready'],
  ['Your Ridely code: 2026', '86753', `Your Ridely code: ${H}`],
  ['2026 is your login code', SHORT, `${H} is your login code`],
  ['gate code is 4821', LONG, `gate code is ${H}`],
  // no exemption for the owner or known contacts
  [
    'the cabin door code is 4821 and wifi is CabinGuest / 55512345',
    ME_,
    `the cabin door code is ${H} and wifi is CabinGuest / ${H}`,
  ],
  ['Your verification code is 482913', ME_, `Your verification code is ${H}`],
  ['Your one-time passcode: 99812', LONG, `Your one-time passcode: ${H}`],
  ['2FA: 4821', LONG, `2FA: ${H}`],
  ['Your security code is 9921', LONG, `Your security code is ${H}`],
  ['Your confirmation code is 4829', LONG, `Your confirmation code is ${H}`],
  ['Authentication code 557720', LONG, `Authentication code ${H}`],
  // confirm wording, enter/reply without "to", spaced, dashed and dotted codes, PIN phrasing
  ['To confirm your account, enter 482913', LONG, `To confirm your account, enter ${H}`],
  ['Reply 482913 to confirm', LONG, `Reply ${H} to confirm`],
  ['482913 to confirm your number', LONG, `${H} to confirm your number`],
  ['Confirm with 482913', LONG, `Confirm with ${H}`],
  ['Enter 482913 in the app to continue', LONG, `Enter ${H} in the app to continue`],
  [
    'Your account access request was received. To continue, please enter 482913',
    LONG,
    `Your account access request was received. To continue, please enter ${H}`,
  ],
  ['To finish setting up WhatsApp, enter 482913', LONG, `To finish setting up WhatsApp, enter ${H}`],
  ['Type 482913 to confirm', LONG, `Type ${H} to confirm`],
  [
    'Northwind Bank: Use 482913 as your one-time passcode.',
    LONG,
    `Northwind Bank: Use ${H} as your one-time passcode.`,
  ],
  ['Telegram: 48291. Do not give this to anyone', LONG, `Telegram: ${H}. Do not give this to anyone`],
  ['Do not share: 482-913', LONG, `Do not share: ${H}`],
  ['Your code is 4 8 2 9 1 3', LONG, `Your code is ${H}`],
  ['Code: 4 8 2 9 1 3', LONG, `Code: ${H}`],
  ['Your code is ABC-123', LONG, `Your code is ${H}`],
  ['Your code is 482.913', LONG, `Your code is ${H}`],
  ['Código de verificación: 482913', LONG, `Código de verificación: ${H}`],
  ['My PIN for the lockbox is 0420', LONG, `My PIN for the lockbox is ${H}`],
  [
    'Venmo me 45 for the cabin. My PIN for the lockbox is 0420',
    LONG,
    `Venmo me 45 for the cabin. My PIN for the lockbox is ${H}`,
  ],
  ['Your code is 555-0142', LONG, `Your code is ${H}`],
  // bare sign in / log in, labelled numbers and local phone numbers stay visible
  ['Sign in at 9:30, room 4120', LONG, 'Sign in at 9:30, room 4120'],
  ['Sign in at the front desk, room 1204', LONG, 'Sign in at the front desk, room 1204'],
  ['Logging in now, my flight lands at 1530', LONG, 'Logging in now, my flight lands at 1530'],
  ['Can you log in and check order 482913?', LONG, 'Can you log in and check order 482913?'],
  ['verified: the apartment is unit 4021', LONG, 'verified: the apartment is unit 4021'],
  ['your code review is at 14:30 in room 2201', LONG, 'your code review is at 14:30 in room 2201'],
  ['call me at 555-0142, code word is pineapple', LONG, 'call me at 555-0142, code word is pineapple'],
  ['Call 555-0142 for help', SHORT, 'Call 555-0142 for help'],
  ['Log in with 482913', LONG, `Log in with ${H}`],
  ['The verification took 2026 attempts', LONG, 'The verification took 2026 attempts'],
  ['Order 4829 confirmed', LONG, 'Order 4829 confirmed'],
  ['gate code is 4821, gate 12', LONG, `gate code is ${H}, gate 12`],
  ['Your code is 48-29-13', LONG, `Your code is ${H}`],
  [
    'Your verification code for Northwind Bank online banking access request is 482913',
    LONG,
    `Your verification code for Northwind Bank online banking access request is ${H}`,
  ],
  ['482913 — use this to sign in to Ridely', LONG, `${H} — use this to sign in to Ridely`],
  ['I need to log in to check order 482913', LONG, 'I need to log in to check order 482913'],
  ['the zip code for my new place is 10001', LONG, 'the zip code for my new place is 10001'],
  ['The code review for 2026 planning is at 3pm', LONG, 'The code review for 2026 planning is at 3pm'],
];

describe('redact (shared table)', () => {
  for (const [input, from, want] of REDACTION) {
    it(`${from ?? 'me'}: ${input}`, () => assert.equal(redact(input, from, true), want.replaceAll(H, CODE_MARKER)));
  }
  it('is off when disabled', () => assert.equal(redact('Your code is 482913', SHORT, false), 'Your code is 482913'));
  it('index replacement adds no words and keeps no digits', () => {
    const out = redact("Northwind Bank: Your verification code is 482913. Don't share it.", SHORT, true, {
      replacement: ' ',
    });
    assert.equal(out, "Northwind Bank: Your verification code is  . Don't share it.");
    assert.doesNotMatch(out, /hidden|4829|2913/);
  });
  it('the marker says why', () => assert.equal(CODE_MARKER, '[verification code hidden]'));
});

const newStore = () => newMockStore();
const OPTS = { redactCodes: true };
const chatOf = (store: MessageStore, id: string) => store.chat(id)!;
const lastOf = (store: MessageStore, chatId: string) => store.summarizeChat(chatId).lastMessage!;

describe('names', () => {
  const store = newStore();
  it('shortName keeps phone numbers whole', () => {
    assert.equal(shortName('Sam Ortiz'), 'Sam');
    assert.equal(shortName('(555) 555-0188'), '(555) 555-0188');
    assert.equal(shortName('+44 20 7946 0958'), '+44 20 7946 0958');
  });
  it('senderLabels: First L. for shared first names, whole numbers for unknowns', () => {
    const cabin = senderLabels(store, chatOf(store, 'iMessage;+;chat58213'));
    assert.equal(cabin.get('p_sam_ortiz'), 'Sam O.');
    assert.equal(cabin.get('p_sam_lee'), 'Sam L.');
    assert.equal(cabin.get('p_jo'), 'Jo');
    const strangers: Chat = {
      chatId: 'x',
      type: 'group',
      service: 'iMessage',
      displayName: null,
      participantIds: ['p_5555550188', 'p_5555550199'],
      createdAt: 0,
      labels: [],
    };
    const l = senderLabels(store, strangers);
    assert.equal(l.get('p_5555550188'), '(555) 555-0188');
    assert.equal(l.get('p_5555550199'), '(555) 555-0199');
  });
  it('akaOf and isUnknownDm', () => {
    assert.deepEqual(akaOf(store, 'p_linda'), ['Mom']);
    assert.deepEqual(akaOf(store, 'p_jo'), []);
    assert.equal(isUnknownDm(store, chatOf(store, 'iMessage;-;+15555550188')), true);
    assert.equal(isUnknownDm(store, chatOf(store, 'iMessage;-;+15555550111')), false);
    assert.equal(isUnknownDm(store, chatOf(store, 'iMessage;+;chat58213')), false);
  });
  it('REACTION_EMOJI is exported', () => assert.equal(REACTION_EMOJI.laugh, '😂'));
});

describe('chatHeader / chatLine / chatJson', () => {
  const store = newStore();
  it('header flags unknown senders and shows the nickname', () => {
    const inj = chatHeader(store, chatOf(store, 'iMessage;-;+15555550188'));
    assert.match(inj, /^\(555\) 555-0188 · 1:1 · iMessage · not in Contacts · chat_id iMessage;-;\+15555550188$/);
    assert.match(
      chatHeader(store, chatOf(store, 'iMessage;-;+15555550111')),
      /^Linda Carter · 1:1 · aka Mom · iMessage · chat_id /,
    );
    assert.doesNotMatch(chatHeader(store, chatOf(store, 'iMessage;+;chat58213')), /aka|not in Contacts/);
  });
  it('triage ranks and labels needs-reply chats', () => {
    const rank = (id: string) => needsReplyTriage(store, store.summarizeChat(id));
    assert.deepEqual(rank('iMessage;-;+15555550111'), { rank: 0 });
    assert.deepEqual(rank('iMessage;+;chat58213'), { rank: 1, label: 'group' });
    assert.deepEqual(rank('SMS;-;+15555550166'), { rank: 2, label: 'broadcast' });
    assert.deepEqual(rank('iMessage;-;+15555550188'), { rank: 3, label: 'unknown sender' });
    assert.deepEqual(rank('SMS;-;+15555550199'), { rank: 3, label: 'unknown sender' });
    const waiting = store
      .chatSummaries()
      .filter((s) => s.needsReply)
      .map((s) => ({ s, r: needsReplyTriage(store, s).rank }))
      .sort((a, b) => a.r - b.r || b.s.lastMessage!.sentAt - a.s.lastMessage!.sentAt);
    assert.equal(waiting[0].r, 0);
    assert.equal(waiting[waiting.length - 1].r, 3);
  });
  it('chatLine: labelled needs reply, aka, full sender labels', () => {
    const inj = chatLine(store, store.summarizeChat('iMessage;-;+15555550188'), OPTS);
    assert.match(inj, /needs reply \(unknown sender\)/);
    assert.doesNotMatch(inj, /· unknown sender/);
    assert.match(inj, / — \(555\) 555-0188: /);
    const mom = chatLine(store, store.summarizeChat('iMessage;-;+15555550111'), OPTS);
    assert.match(mom, /\[1:1 · iMessage · aka Mom · /);
    assert.match(mom, /needs reply\]/);
    assert.match(chatLine(store, store.summarizeChat('SMS;-;+15555550166'), OPTS), /needs reply \(broadcast\)/);
    const cabin = store.summarizeChat('iMessage;+;chat58213');
    assert.match(chatLine(store, cabin, OPTS), /needs reply \(group\)/);
    const samL = store.listMessages(
      { chatIds: [cabin.chat.chatId], from: { kind: 'person', personId: 'p_sam_lee' } },
      { order: 'desc', limit: 1, offset: 0 },
    ).items[0];
    assert.match(chatLine(store, { ...cabin, lastMessage: samL }, OPTS), / — Sam L\.: /);
  });
  it('a failed last send is marked in the line and JSON', () => {
    const dadId = 'RCS;-;+15555550112';
    const m = lastOf(store, dadId);
    assert.equal(m.senderId, ME);
    const before = m.status;
    assert.doesNotMatch(chatLine(store, store.summarizeChat(dadId), OPTS), /not delivered/);
    assert.equal('status' in (chatJson(store, store.summarizeChat(dadId), OPTS).last_message ?? {}), false);
    m.status = 'failed';
    try {
      assert.match(chatLine(store, store.summarizeChat(dadId), OPTS), /— You: .* {3}✗ not delivered \(/);
      assert.equal(chatJson(store, store.summarizeChat(dadId), OPTS).last_message?.status, 'failed');
    } finally {
      m.status = before;
    }
  });
  it('chatJson: aka on participants, participants_omitted only past 10, needs_reply_label', () => {
    const mom = chatJson(store, store.summarizeChat('iMessage;-;+15555550111'), OPTS);
    assert.deepEqual(mom.participants[0], { person_id: 'p_linda', name: 'Linda Carter', aka: ['Mom'] });
    assert.equal('needs_reply_label' in mom, false);
    const cabin = store.summarizeChat('iMessage;+;chat58213');
    const cj = chatJson(store, cabin, OPTS);
    assert.equal('participants_omitted' in cj, false);
    assert.equal(cj.needs_reply_label, 'group');
    const big = chatJson(
      store,
      { ...cabin, chat: { ...cabin.chat, participantIds: Array.from({ length: 12 }, (_, i) => `p_x${i}`) } },
      OPTS,
    );
    assert.equal(big.participants.length, 10);
    assert.equal(big.participant_count, 13);
    assert.equal(big.participants_omitted, 2);
  });
});

describe('renderLine / messageText / messageJson', () => {
  const store = newStore();
  const tz = store.timeZone;
  const labels = (chatId: string) => senderLabels(store, chatOf(store, chatId));
  const mine = lastOf(store, 'iMessage;-;+15555550133'); // Jo: "thank you!!" (read)
  it('an unsent message has no delivery status', () => {
    const unsent = store
      .listMessages(
        { chatIds: ['iMessage;-;+15555550133'], from: { kind: 'me' } },
        { order: 'asc', limit: 50, offset: 0 },
      )
      .items.find((m) => m.unsent)!;
    const line = renderLine(store, unsent, labels(unsent.chatId), OPTS);
    assert.match(line, /You: \[unsent\]/);
    assert.doesNotMatch(line, /✓/);
    assert.equal('status' in messageJson(store, unsent, OPTS), false);
  });
  it('read receipts carry a date when read on a later day', () => {
    const sameDay: Message = { ...mine, status: 'read', readAt: mine.sentAt + 60_000 };
    assert.match(
      renderLine(store, sameDay, labels(mine.chatId), OPTS),
      new RegExp(`✓ read ${fmtClock(sameDay.readAt!, tz)}  #`),
    );
    const later: Message = { ...mine, status: 'read', readAt: mine.sentAt + 2 * 86_400_000 };
    assert.ok(
      renderLine(store, later, labels(mine.chatId), OPTS).includes(
        `✓ read ${fmtShort(later.readAt!, tz, store.now())}`,
      ),
    );
  });
  it('hides codes in link preview titles and URLs, like the text', () => {
    const link = {
      url: 'https://bank.example/verify?code=482913',
      title: 'Your verification code is 482913',
      site: 'bank.example',
    };
    const theirs: Message = { ...mine, senderId: 'p_jo', text: '', link };
    const line = renderLine(store, theirs, labels(mine.chatId), OPTS);
    assert.ok(line.includes(`[link "Your verification code is ${CODE_MARKER}"]`));
    assert.doesNotMatch(line, /482913/);
    const j = messageJson(store, theirs, OPTS);
    assert.deepEqual(j.link, {
      url: `https://bank.example/verify?code=${CODE_MARKER}`,
      title: `Your verification code is ${CODE_MARKER}`,
      site: 'bank.example',
    });
    assert.equal(messageJson(store, theirs, { redactCodes: false }).link?.title, link.title);
  });
  it('tapbacks name their bubble only on multi-bubble messages', () => {
    const at = mine.sentAt + 1000;
    const multi = {
      ...mine,
      partCount: 2,
      reactions: [
        { kind: 'love' as const, by: ME, at, part: 0 },
        { kind: 'laugh' as const, by: 'p_jo', at, part: 1 },
      ],
    } as Message;
    assert.match(renderLine(store, multi, labels(mine.chatId), OPTS), /❤️ You ·part 0, 😂 Jo ·part 1/);
    const j = messageJson(store, multi, OPTS);
    assert.equal(j.part_count, 2);
    assert.deepEqual(
      j.reactions.map((r) => r.part),
      [0, 1],
    );
    const single = { ...mine, reactions: [{ kind: 'love' as const, by: ME, at }] } as Message;
    assert.doesNotMatch(renderLine(store, single, labels(mine.chatId), OPTS), /part/);
    assert.equal('part_count' in messageJson(store, single, OPTS), false);
    assert.equal('part' in messageJson(store, single, OPTS).reactions[0], false);
  });
  it('moreHint replaces or drops the truncation hint', () => {
    const recipe = store.search(
      { text: 'crust', chatIds: ['iMessage;-;+15555550111'] },
      { sort: 'newest', limit: 1, offset: 0 },
    ).items[0];
    assert.match(messageText(store, recipe, { ...OPTS, maxChars: 20 }), /… \[\+\d+ chars, get_message for all\]$/);
    assert.match(
      messageText(store, recipe, { ...OPTS, maxChars: 20, moreHint: `fetch msg:${recipe.messageId} for all` }),
      /chars, fetch msg:m\d+ for all\]$/,
    );
    const plain = messageText(store, recipe, { ...OPTS, maxChars: 20, moreHint: false });
    assert.equal(plain.length, 21);
    assert.ok(plain.endsWith('…'));
  });
  it('messageJson: in_contacts only for strangers, from.address prefers the sending handle', () => {
    const inj = messageJson(store, lastOf(store, 'iMessage;-;+15555550188'), OPTS);
    assert.equal((inj.from as { in_contacts?: boolean }).in_contacts, false);
    const sam = store.listMessages(
      { chatIds: ['iMessage;-;sam.ortiz@example.com'], from: { kind: 'others' } },
      { order: 'asc', limit: 1, offset: 0 },
    ).items[0];
    const plain = messageJson(store, { ...sam, senderAddress: undefined } as Message, OPTS).from as {
      address?: string;
      in_contacts?: boolean;
    };
    assert.equal(plain.address, '+15555550142');
    assert.equal('in_contacts' in plain, false);
    assert.equal(
      (
        messageJson(store, { ...sam, senderAddress: 'sam.ortiz@example.com' } as Message, OPTS).from as {
          address?: string;
        }
      ).address,
      'sam.ortiz@example.com',
    );
  });
  it('codes in rendered text use the marker', () => {
    const bank = lastOf(store, 'SMS;-;28734');
    assert.ok(messageText(store, bank, OPTS).includes(CODE_MARKER));
    assert.doesNotMatch(messageText(store, bank, OPTS), /482913/);
    assert.match(messageText(store, bank, { redactCodes: false }), /482913/);
  });
});

describe('attachments', () => {
  const store = newStore();
  const all = store.listAttachments({}, { limit: 100, offset: 0 }).items;
  const byName = (n: string) => all.find((a) => a.name === n)!;
  const noText = {
    attachmentText: async () => null,
    person: (id: string) => store.person(id),
    personName: (id: string) => store.personName(id),
  } as unknown as MessageStore;
  it('fmtBytes and attachmentFacts', () => {
    assert.equal(fmtBytes(512), '512 B');
    assert.equal(fmtBytes(182_220), '182 KB');
    assert.equal(fmtBytes(1_204_551), '1.2 MB');
    const memo = byName('Audio Message.caf');
    assert.equal(attachmentFacts(memo), 'Audio Message.caf · voice memo · 182 KB · 23s');
    assert.equal(
      attachmentFacts({ ...memo, onDevice: false }),
      'Audio Message.caf · voice memo · 182 KB · 23s · in iCloud, not on the Mac',
    );
    assert.equal(attachmentFacts(byName('IMG_4410.JPG')), 'IMG_4410.JPG · image · 1.2 MB · 3024×4032');
  });
  it('PDF text keeps its years and amounts and pages by offset', async () => {
    const lease = byName('lease-renewal-2027.pdf');
    const full = await extractedTextBlock(store, lease, { redactCodes: true, maxChars: 20000 });
    assert.ok(full.startsWith(`${UNTRUSTED_NOTICE}\nExtracted text:\n`));
    assert.match(full, /2027/);
    assert.match(full, /November 15, 2026/);
    assert.match(full, /\$2,350/);
    assert.doesNotMatch(full, /\[chars/);
    const n = lease.extractedText!.length;
    assert.ok(
      (await extractedTextBlock(store, lease, { redactCodes: true, maxChars: 50 })).endsWith(
        `\n… [chars 1–50 of ${n}; call again with offset=50 for the rest]`,
      ),
    );
    assert.ok(
      (await extractedTextBlock(store, lease, { redactCodes: true, maxChars: 20000, offset: 50 })).endsWith(
        `\n[chars 51–${n} of ${n}, end of text]`,
      ),
    );
    assert.match(
      await extractedTextBlock(store, lease, { redactCodes: true, maxChars: 100, offset: n }),
      new RegExp(`^offset ${n} is past the end \\(${n} chars\\)\\.\nFix: `),
    );
  });
  it('image text is labelled OCR and code-redacted for the sender', async () => {
    assert.match(
      await extractedTextBlock(store, byName('IMG_4410.JPG'), { redactCodes: true, maxChars: 1000 }),
      /\nText found in the image \(OCR\):\n/,
    );
    const shot: Attachment = {
      ...byName('IMG_4410.JPG'),
      senderId: 'p_28734',
      extractedText: 'Northwind Bank\nYour code is 551204',
    };
    const hidden = await extractedTextBlock(store, shot, { redactCodes: true, maxChars: 1000 });
    assert.ok(hidden.includes(CODE_MARKER));
    assert.doesNotMatch(hidden, /551204/);
    assert.match(await extractedTextBlock(store, shot, { redactCodes: false, maxChars: 1000 }), /551204/);
  });
  it('honest bodies when there is no text', async () => {
    const memo: Attachment = { ...byName('Audio Message.caf'), extractedText: undefined };
    const body = await extractedTextBlock(noText, memo, { redactCodes: true, maxChars: 1000 });
    assert.equal(
      body,
      "No transcript: audio transcription isn't supported on this Mac.\nFix: Tell the user it's a 23s voice memo from Linda Carter; they can play it in Messages, or use mode=link for a download URL.",
    );
    assert.equal(
      await extractedTextBlock(
        noText,
        { ...byName('IMG_5012.MOV'), extractedText: undefined },
        { redactCodes: true, maxChars: 1000 },
      ),
      'No text in videos.\nFix: Use mode=preview for a thumbnail.',
    );
    assert.equal(
      await extractedTextBlock(
        noText,
        { ...byName('Q4-launch-plan.pdf'), extractedText: undefined },
        { redactCodes: true, maxChars: 1000 },
      ),
      '(no text could be extracted; try mode=preview)',
    );
    assert.match(
      await extractedTextBlock(
        noText,
        { ...byName('Q4-launch-plan.pdf'), extractedText: undefined, onDevice: false },
        { redactCodes: true, maxChars: 1000 },
      ),
      /stored in iCloud[\s\S]*\nFix: /,
    );
    assert.match(
      await extractedTextBlock(store, byName('Audio Message.caf'), { redactCodes: true, maxChars: 1000 }),
      /\nTranscript:\n|^No transcript/,
    );
  });
  it('store errors propagate', async () => {
    const failing = {
      ...noText,
      attachmentText: async () => {
        throw new ToolError('unavailable', 'The Mac is busy.', 'Try again.');
      },
    } as unknown as MessageStore;
    await assert.rejects(
      extractedTextBlock(
        failing,
        { ...byName('Q4-launch-plan.pdf'), extractedText: undefined },
        { redactCodes: true, maxChars: 100 },
      ),
      (e: unknown) => e instanceof ToolError && e.code === 'unavailable',
    );
  });
});
