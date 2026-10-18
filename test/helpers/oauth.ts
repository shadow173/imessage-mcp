import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { pkceS256, randomId } from '../../src/auth/crypto.js';

/** fetch, or Hono's app.request: takes a path on the gateway. */
export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export const LOOPBACK_REDIRECT = 'http://127.0.0.1:8976/callback';

/**
 * A real scrypt hash at a low cost, so tests that try many passwords stay fast. verifyPassword reads the cost from the
 * hash, the way hashes made with an older, cheaper N keep working.
 */
export function cheapPasswordHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, 32, { N: 1024, r: 8, p: 1 });
  return ['scrypt', 1024, 8, 1, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** Registers a client (RFC 7591) and returns the registration response. */
export async function register(
  f: Fetcher,
  body: Record<string, unknown> = {},
): Promise<{ client_id: string; client_secret?: string }> {
  const res = await f('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [LOOPBACK_REDIRECT], client_name: 'Test client', ...body }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}

export interface ConsentOptions {
  clientId: string;
  redirect?: string;
  scopes?: string[];
  /** Optional scopes ticked on the consent page (read is always granted). */
  allow?: string[];
  password: string;
  action?: 'allow' | 'deny';
  /** Sent as X-Forwarded-For, the address the throttle keys on. */
  forwardedFor?: string;
  /** Extra or replacement /authorize query parameters. */
  query?: Record<string, string>;
}

/** GET /authorize then POST the consent form. Returns the POST response and the PKCE verifier. */
export async function consent(f: Fetcher, o: ConsentOptions) {
  const verifier = randomId(32);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: o.clientId,
    redirect_uri: o.redirect ?? LOOPBACK_REDIRECT,
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    state: 'st8',
    scope: (o.scopes ?? ['messages.read', 'messages.send']).join(' '),
    ...o.query,
  });
  const page = await f(`/authorize?${q}`, { redirect: 'manual' });
  if (page.status !== 200) return { res: page, verifier };
  const req = (await page.text()).match(/name="req" value="([^"]+)"/)![1];
  const form = new URLSearchParams({ req, password: o.password, action: o.action ?? 'allow' });
  for (const s of o.allow ?? ['messages.send']) form.append('scope', s);
  const res = await f('/authorize', {
    method: 'POST',
    body: form,
    redirect: 'manual',
    headers: o.forwardedFor ? { 'x-forwarded-for': o.forwardedFor } : {},
  });
  return { res, verifier };
}

/** POST /token with a form body. */
export async function token(f: Fetcher, params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await f('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
  return { status: res.status, json: (await res.json()) as any }; // token and error replies differ in shape
}

/** The whole sign-in for a public client: consent, then the code exchange. Returns the code and token responses. */
export async function authorize(f: Fetcher, o: ConsentOptions & { tokenParams?: Record<string, string> }) {
  const { res, verifier } = await consent(f, o);
  assert.equal(res.status, 302, await res.clone().text());
  const loc = new URL(res.headers.get('location')!);
  const code = loc.searchParams.get('code')!;
  const t = await token(f, {
    grant_type: 'authorization_code',
    code,
    client_id: o.clientId,
    code_verifier: verifier,
    redirect_uri: o.redirect ?? LOOPBACK_REDIRECT,
    ...o.tokenParams,
  });
  return { location: loc, code, verifier, ...t };
}
