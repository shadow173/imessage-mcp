import { isShortCode } from '../lib/address.js';

/** What a hidden one-time code renders as, so the reader knows it is policy and not missing data. */
export const CODE_MARKER = '[verification code hidden]';

/**
 * Words that make nearby digits a likely one-time code. Word-bounded and narrow: no bare "pin", "confirm", "security",
 * "signing" or "sign in" (only "to sign in", "sign-in code"); "enter/type/reply N" and "use N to" carry the digits in
 * the match.
 */
const CODE_TRIGGERS = new RegExp(
  [
    // First, so it wins at its position: "Your verification code for <a long account name> is 482913" (code word and
    // "is" in one sentence)
    String.raw`(?<!\b(?:zip|postal|area|country) )\b(?:code|passcode|pin|otp)\b[^.!?\n]{0,80}?\bis\s*:?\s*(?=[A-Z0-9-]*\d)`,
    String.raw`(?<!\b(?:zip|postal|area|country) )\bcodes?\b`,
    String.raw`\bverif\w*`,
    String.raw`\bpass ?codes?\b`,
    String.raw`\bc[oó]digo\b`,
    String.raw`\bone[- ]time (?:code|pass\w*|pin|key|login)\b`,
    String.raw`\b(?:otp|2fa|mfa)\b`,
    String.raw`\btwo[- ](?:factor|step)\b`,
    String.raw`\b2[- ]step\b`,
    String.raw`\bauthenticat\w*`,
    String.raw`\bsecurity (?:code|key|pin)\b`,
    String.raw`\b(?:sign(?:ing)?|log(?:ging)?)[- ]?in\s+(?:code|pin|with\s+(?=\d))`,
    String.raw`\bpin\s*(?:is\b|:|#|code\b|number\b|(?=\d{4}))`,
    String.raw`\bpin\b(?:\s+[\p{L}\d']+){1,4}(?:\s+is\b|:)`,
    String.raw`\b(?:enter|type|reply(?:\s+with)?)\s+(?:(?:the\s+)?code\s+)?\d[\d\u00a0\u202f -]{2,10}\d\b`,
    String.raw`\buse\s+(?:code\s+)?\d[\d\u00a0\u202f -]{2,10}\d\s+(?:to|as)\b`,
    String.raw`\bto\s+(?:confirm|sign[- ]?in|log[- ]?in)\b`,
    String.raw`\bconfirm(?:ation)?\s+(?:code|pin|with)\b`,
    String.raw`\b(?:do\s+not|don'?t|never)\s+(?:share|give)\b`,
  ].join('|'),
  'giu',
);
/** Right after a code word ("code is", "PIN:", "otp -"), these shapes are a code. */
const AFTER_CODE_WORD = String.raw`(?<=\b(?:code|passcode|pin|otp)(?:\s+is)?\s*[:#-]?\s*)`;
const SHAPES_AFTER_CODE_WORD = [
  // 5-8 letters and digits with at least one digit: 482913, A7K2QX
  String.raw`(?=[A-Z0-9]*\d)[A-Z0-9]{5,8}\b`,
  // single digits spaced or dashed: 4 8 2 9 1 3
  String.raw`\d(?:[ -]\d){3,7}\b(?![ -]\d)`,
  // dashed groups with a digit: ABC-123, 12-34-56
  String.raw`(?=[A-Z0-9-]*\d)[A-Z0-9]{2,4}(?:-[A-Z0-9]{2,4}){1,2}\b(?!-)`,
  // 482.913
  String.raw`\d{3}\.\d{3}\b`,
];
/** Anywhere else: never glued to a letter, digit, currency sign or decimal point, nor the tail of a phone number. */
const NOT_GLUED = String.raw`(?<![\p{L}\d$€£¥.,])(?<!\d[-\u00a0\u202f ])(?<!\)\s?)`;
const SHAPES_ANYWHERE = [
  // 3+3, 4-4 or 2-2-2 groups split by a space, dash or no-break space
  String.raw`\d{2,4}(?:[-\u00a0\u202f ]\d{2,4}){1,2}(?![-\u00a0\u202f ]?\d)`,
  // a 4-8 digit run
  String.raw`\d{4,8}`,
];
/** ...and not followed by more digits, decimals, a percent sign, or a money or points word. */
const NOT_AN_AMOUNT = String.raw`(?![.,]?\d|\s?(?:%|(?:usd|eur|gbp|dollars?|euros?|bucks|points|pts)\b))`;
const CODE_SHAPES = new RegExp(
  `${AFTER_CODE_WORD}(?:${SHAPES_AFTER_CODE_WORD.join('|')})|${NOT_GLUED}(?:${SHAPES_ANYWHERE.join('|')})${NOT_AN_AMOUNT}`,
  'giu',
);
/** How far from a code word (either side) a code shape may sit, for senders that aren't short codes. */
const CODE_NEAR = 40;
/** How far back redact looks for a code word or a label ("room", "flight") before a code shape. */
const CODE_WORD_LOOKBACK = 30;
/** For a year-shaped match: how far back a code word makes it a code, and how far ahead "is your/the" does. */
const YEAR_CODE_WORD_LOOKBACK = 24;
const YEAR_LOOKAHEAD = 16;
/**
 * The digits come straight after a code word or an "enter/use/type/reply" verb: then they are the code whatever they
 * look like.
 */
const CODE_WORD_BEFORE =
  /(?:\b(?:code|pin|passcode|otp)(?:\s+is)?\s*[:#-]?|\b(?:enter|use|type|reply)(?:\s+(?:with|code|the\s+code))?)\s*$/i;
/** A number labelled as something else: room 1204, unit 4021, flight 1530, order 482913, gate 12. */
const LABEL_BEFORE =
  /\b(?:room|rm|suite|ste|apt|apartment|unit|gate|flight|order|seat|platform|terminal|ext|extension)\.?(?:\s+(?:number|no\.?))?\s*#?\s*$/i;
const LOCAL_PHONE = /^\d{3}[-\s]\d{4}$/u;
const DATE_SHAPE = /^(?:(?:19|20)\d\d-\d\d-\d\d|\d\d-\d\d-(?:19|20)\d\d)$/;

/**
 * True when a code-shaped match should stay visible: a 1900-2099 year that isn't the code itself, or a date. strict: no
 * year exemption.
 */
function looksLikeYearOrDate(text: string, s: string, at: number, strict: boolean): boolean {
  if (DATE_SHAPE.test(s)) return true;
  if (strict || !/^(?:19|20)\d\d$/.test(s)) return false;
  return (
    !CODE_WORD_BEFORE.test(text.slice(Math.max(0, at - YEAR_CODE_WORD_LOOKBACK), at)) &&
    !/^\s+is\s+(?:your|the)\b/i.test(text.slice(at + s.length, at + s.length + YEAR_LOOKAHEAD))
  );
}

/**
 * Hides one-time codes. Short-code senders: every code shape (a year stays only when no code word is near). Anyone
 * else, known contacts and the owner included: only code shapes within ~40 chars of a code word, never a local phone
 * number or a labelled number (room 1204) unless it follows a code word. opts.replacement lets the search index drop
 * codes.
 */
export function redact(
  text: string,
  senderAddress: string | undefined,
  enabled: boolean,
  opts: { replacement?: string } = {},
): string {
  if (!enabled || !/\d/.test(text)) return text;
  const shortCode = senderAddress ? isShortCode(senderAddress) : false;
  const near = [...text.matchAll(CODE_TRIGGERS)].map(
    (m) => [m.index - CODE_NEAR, m.index + m[0].length + CODE_NEAR] as const,
  );
  if (!shortCode && !near.length) return text;
  const mark = opts.replacement ?? CODE_MARKER;
  return text.replace(CODE_SHAPES, (s: string, at: number) => {
    const isNear = near.some(([from, to]) => at <= to && at + s.length >= from);
    if (!shortCode && !isNear) return s;
    const before = text.slice(Math.max(0, at - CODE_WORD_LOOKBACK), at);
    const afterCodeWord = CODE_WORD_BEFORE.test(before);
    if (!afterCodeWord && (LOCAL_PHONE.test(s) || (!shortCode && LABEL_BEFORE.test(before)))) return s;
    if (/[a-z]/i.test(s)) return mark;
    const digits = s.replace(/\D/g, '').length;
    if (digits < 4 || digits > 8 || looksLikeYearOrDate(text, s, at, shortCode && isNear)) return s;
    return mark;
  });
}
