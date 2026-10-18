// Text matching shared by the stores, mirroring the live FTS5 index (unicode61, remove_diacritics 2).

/** Splits a query into lowercase terms, keeping "quoted phrases" whole. */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push((m[1] ?? m[2]).toLowerCase());
  return out;
}

/**
 * Loose match for "closest" fallbacks: cabins -> cabin, groceries -> grocery, booking/booked -> book. Keeps 3+ letters.
 */
export function stemWord(w: string): string {
  const x = w.toLowerCase();
  const cut = (n: number, add = '') => (x.length - n + add.length >= 3 ? x.slice(0, x.length - n) + add : x);
  if (x.endsWith('ies')) return cut(3, 'y');
  if (x.endsWith('ing')) return cut(3);
  if (x.endsWith('es') && !x.endsWith('ses')) return cut(2);
  if (x.endsWith('ed')) return cut(2);
  if (x.endsWith('s') && !x.endsWith('ss')) return cut(1);
  return x;
}

/** Words the way the FTS5 tokenizer sees them: runs of letters and digits, lowercased, diacritics removed. */
export function wordTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export interface TextTerm {
  tokens: string[];
  prefix: boolean;
}

/**
 * Like ftsQuery: a "quoted phrase" is exact consecutive words; a plain word of 3+ chars matches its last token as a
 * prefix.
 */
export function textTerms(q: string, stem = false): TextTerm[] {
  const out: TextTerm[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    if (m[1]) {
      const tokens = wordTokens(m[1]);
      if (tokens.length) out.push({ tokens, prefix: false });
      continue;
    }
    let word = m[2].replace(/[^\p{L}\p{N}'_-]/gu, '');
    if (stem && /^\p{L}+$/u.test(word)) word = stemWord(word);
    const tokens = wordTokens(word);
    if (tokens.length) out.push({ tokens, prefix: word.length >= 3 });
  }
  return out;
}

/** How many times the term occurs in a token list (never mid-word: "abin" does not match "cabin"). */
export function termHits(hay: string[], t: TextTerm): number {
  let n = 0;
  for (let i = 0; i + t.tokens.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < t.tokens.length && ok; j++) {
      const h = hay[i + j],
        q = t.tokens[j];
      ok = h === q || (t.prefix && j === t.tokens.length - 1 && h.startsWith(q));
    }
    if (ok) n++;
  }
  return n;
}

/** "https://www.Example.com/x" or "example.com." -> "example.com". */
export function normDomain(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

/** A link's host without "www.", from its URL (falling back to the preview's site). */
export function linkHost(url: string, site = ''): string {
  try {
    return normDomain(new URL(url).hostname);
  } catch {
    return normDomain(site);
  }
}

export const hostMatches = (host: string, domain: string) =>
  !!domain && (host === domain || host.endsWith(`.${domain}`));
