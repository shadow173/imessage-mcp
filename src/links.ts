// Signed links the tools hand out and the gateway serves: /files downloads and /view citation pages. Both are signed
// with LINK_SECRET on the Mac and checked on the gateway, so the two must share it.
import { hmac, safeEqual } from './auth/crypto.js';
import { DAY_MS } from './lib/units.js';

/** A download link (get_attachment mode=link) works for 15 minutes. */
const FILE_LINK_TTL_S = 15 * 60;
const DAY_S = DAY_MS / 1000;
/** A citation link works for 30 days, counted from the start of the UTC day it was made. */
const VIEW_TTL_DAYS = 30;

/** The sig on /files/<id>?exp=<unix s>&sig=. */
export const signFile = (secret: string, id: string, exp: number) => hmac(secret, `${id}.${exp}`).slice(0, 32);

/** A signed /files URL for an attachment, made at now (ms); exp is when it stops working, in Unix seconds. */
export function fileLink(baseUrl: string, secret: string, id: string, now: number): { url: string; exp: number } {
  const exp = Math.floor(now / 1000) + FILE_LINK_TTL_S;
  return { url: `${baseUrl}/files/${encodeURIComponent(id)}?exp=${exp}&sig=${signFile(secret, id, exp)}`, exp };
}

/**
 * True when a /files link's exp (Unix s, as it appears in the URL) hasn't passed and its sig is genuine. exp must be
 * plain digits: then the signed `${id}.${exp}` splits only one way, at its last dot.
 */
export function verifyFileLink(
  secret: string,
  id: string,
  exp: string | null | undefined,
  sig: string | null | undefined,
  now: number,
): boolean {
  if (!exp || !/^\d{1,12}$/.test(exp)) return false;
  const at = Number(exp);
  return at * 1000 >= now && safeEqual(sig ?? '', signFile(secret, id, at));
}

/** The sig on /view/<kind>/<id>?sig&exp&u: until (ms) is signed too, so a link can't be stretched to newer messages. */
export const viewSig = (secret: string, kind: string, id: string, exp: number, until: number) =>
  hmac(secret, `view:v2:${kind}:${id}:${exp}:${until}`).slice(0, 32);

/**
 * A signed /view URL made at now (ms), which also becomes its until: the page never shows anything newer. exp (Unix s)
 * counts from the start of the UTC day, so it moves once a day.
 */
export function viewLink(baseUrl: string, secret: string, kind: 'chat' | 'msg', id: string, now: number): string {
  const exp = Math.floor(now / 1000 / DAY_S) * DAY_S + VIEW_TTL_DAYS * DAY_S;
  return `${baseUrl}/view/${kind}/${encodeURIComponent(id)}?sig=${viewSig(secret, kind, id, exp, now)}&exp=${exp}&u=${now}`;
}

/**
 * The link's until (ms) when /view/<kind>/<id>?sig&exp&u is genuine and unexpired; null otherwise, old sig-only links
 * included.
 */
export function checkViewLink(
  secret: string,
  kind: string,
  id: string,
  q: { sig?: string; exp?: string; u?: string },
  now: number,
): number | null {
  const exp = Number(q.exp),
    until = Number(q.u);
  if (
    !['chat', 'msg'].includes(kind) ||
    !q.exp ||
    !q.u ||
    !Number.isSafeInteger(exp) ||
    !Number.isSafeInteger(until) ||
    exp * 1000 < now
  )
    return null;
  return safeEqual(q.sig ?? '', viewSig(secret, kind, id, exp, until)) ? until : null;
}
