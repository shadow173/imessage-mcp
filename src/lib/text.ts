/** "1 match", "3 matches": `many` defaults to word + "s". */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** At most n characters, the "…" included; cuts trailing space before the ellipsis. */
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Every character that can start a new line: LF, CR, NEL, and the Unicode line and paragraph separators. Sender text
 * that keeps any of them could fake a new transcript line or a "Fix:" line.
 */
const BREAKS = '\\n\\r\\u0085\\u2028\\u2029';
const BREAK_RUN = new RegExp(`[\\s\\u0085]*[${BREAKS}]+[\\s\\u0085]*`, 'g');
const SPACE_RUN = /[\s\u0085]+/g;

/** Folds each run of line breaks (and the spaces around it) into sep, so the text stays on one line. */
export const foldBreaks = (s: string, sep = ' ↵ ') => s.replace(BREAK_RUN, sep);

/** Collapses all whitespace, line breaks included, into single spaces. */
export const oneLine = (s: string) => s.replace(SPACE_RUN, ' ');
