import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import { decodeJwt } from 'jose';
import type { Config } from '../config.js';
import { MINUTE_MS } from '../lib/units.js';
import {
  ASSERTION_TYPE,
  type CimdFetcher,
  type ClientCache,
  ClientError,
  checkClientSecret,
  isLoopback,
  newClientCache,
  type OAuthClient,
  redirectAllowed,
  redirectMatches,
  registerClient,
  resolveClient,
  verifyClientAssertion,
} from './clients.js';
import { pkceS256, randomId, type Signer, verifyPassword } from './crypto.js';
import { consentPage, errorPage } from './page.js';
import { ALL_SCOPES, parseScopes, SCOPES } from './scopes.js';

export interface AuthDeps {
  cfg: Config;
  signer: Signer;
  fetchCimd: CimdFetcher;
  issuer: (c: Context) => string;
  /** Defaults to a fresh state per registerOAuthRoutes call. */
  state?: AuthState;
}

export const resourceFor = (issuer: string) => `${issuer}/mcp`;
/** Audiences accepted on access tokens: ChatGPT's examples use the origin, Claude requires the full MCP URL. */
export const acceptedAudiences = (issuer: string) => [resourceFor(issuer), issuer, `${issuer}/`];
export const resourceMetadataUrl = (issuer: string) => `${issuer}/.well-known/oauth-protected-resource/mcp`;

// Claim keys are short because the tokens travel in URLs and headers. Renaming them would invalidate every refresh
// token already issued.

/** The consent form's signed state between GET and POST /authorize. */
interface AuthRequest {
  /** client_id */
  cid: string;
  /** Client name shown on the consent page. */
  cn: string;
  /** redirect_uri */
  ru: string;
  /** PKCE code_challenge (S256). */
  cc: string;
  /** The client's state parameter, echoed back. */
  st?: string;
  /** Requested scopes. */
  sc: string[];
  /** Resource (audience) the tokens will carry. */
  res: string;
}
interface CodeClaims {
  /** One-time id, remembered in usedCodes. */
  jti: string;
  /** client_id */
  cid: string;
  /** redirect_uri */
  ru: string;
  /** PKCE code_challenge (S256). */
  cc: string;
  /** Granted scopes, space-separated. */
  sc: string;
  /** Resource (audience). */
  res: string;
}
interface RefreshClaims {
  /** client_id */
  cid: string;
  /** Granted scopes, space-separated. */
  sc: string;
  aud: string;
  /** TOKEN_VERSION at issue: bumping it revokes everything. */
  ver: number;
  /** Family: every token rotated from one sign-in shares it. */
  fam: string;
  jti: string;
}

/**
 * Everything the OAuth routes remember. It lives in memory and resets on restart, so revocation and refresh-token
 * reuse detection are best-effort; bumping TOKEN_VERSION is the durable way to revoke every token.
 */
export interface AuthState {
  /**
   * Authorization code jti -> when it was first used and the refresh family it started, kept 10 minutes (codes live
   * 5). A second use ends that family (RFC 6749 §4.1.2).
   */
  usedCodes: Map<string, { at: number; fam: string }>;
  /** Refresh family -> when it was revoked (through /revoke, or because a rotated-out token came back). */
  revokedFamilies: Map<string, number>;
  /** Refresh family -> the one refresh token that may be used next, plus the one it replaced. */
  families: Map<string, { jti: string; token: string; prev?: string; at: number }>;
  /** Failed password attempts per key (`ip:<address>` and GLOBAL), as timestamps inside FAILURE_WINDOW_MS. */
  failures: Map<string, number[]>;
  clients: ClientCache;
}
export const newAuthState = (): AuthState => ({
  usedCodes: new Map(),
  revokedFamilies: new Map(),
  families: new Map(),
  failures: new Map(),
  clients: newClientCache(),
});

/**
 * Password throttling. One address gets FREE_FAILURES tries, then each further try waits twice as long as the last,
 * from FIRST_DELAY_MS up to the window. Across all addresses, past GLOBAL_MAX_FAILURES in the window, tries are spaced
 * so the total stays at that rate. Nobody is ever locked out for longer than one delay, the owner included.
 */
const FAILURE_WINDOW_MS = 15 * MINUTE_MS;
const FREE_FAILURES = 5;
const FIRST_DELAY_MS = 30_000;
const GLOBAL_MAX_FAILURES = 20;
const GLOBAL = 'global';
/** Addresses tracked at once; the stalest go first. */
const MAX_TRACKED = 10_000;

/** Drops failures older than the window and returns what's left, forgetting the key when nothing is. */
function pruneFailures(state: AuthState, key: string, now: number): number[] {
  const list = (state.failures.get(key) ?? []).filter((t) => t > now - FAILURE_WINDOW_MS);
  if (list.length) state.failures.set(key, list);
  else state.failures.delete(key);
  return list;
}

/** Seconds until `key` may try a password again; 0 means now. */
function retryAfterSeconds(state: AuthState, key: string, now: number): number {
  const list = pruneFailures(state, key, now);
  const free = key === GLOBAL ? GLOBAL_MAX_FAILURES : FREE_FAILURES;
  if (list.length < free) return 0;
  const delay =
    key === GLOBAL
      ? FAILURE_WINDOW_MS / GLOBAL_MAX_FAILURES
      : Math.min(FAILURE_WINDOW_MS, FIRST_DELAY_MS * 2 ** (list.length - free));
  return Math.max(0, Math.ceil((list[list.length - 1] + delay - now) / 1000));
}

function recordFailure(state: AuthState, keys: string[], now: number) {
  for (const k of keys) {
    const list = pruneFailures(state, k, now);
    state.failures.delete(k); // re-insert at the end: Map order is then oldest activity first
    state.failures.set(k, [...list, now]);
  }
  for (const k of [...state.failures.keys()]) pruneFailures(state, k, now);
  for (const k of state.failures.keys()) {
    if (state.failures.size <= MAX_TRACKED) break;
    if (k !== GLOBAL) state.failures.delete(k);
  }
}

/**
 * The address the nearest proxy saw. Proxies (Railway, Fly, nginx, Cloudflare...) append it to X-Forwarded-For, so the
 * right-most entry is the one a client can't forge. With no proxy there is no header and the socket address is used.
 */
function clientAddress(c: Context): string {
  const hop = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (hop) return hop;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const waitText = (s: number) => (s >= 90 ? `${Math.ceil(s / 60)} min` : `${s} s`);

/** RFC 7636: 43-128 characters from the unreserved set, for both the verifier and the S256 challenge. */
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

const NO_STORE = { 'Cache-Control': 'no-store' };
const CONSENT_HEADERS = {
  ...NO_STORE,
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*; frame-ancestors 'none'",
};

const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
  c.json({ error, error_description: description }, status, NO_STORE);

function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** client_secret_basic (split at the first colon, each half URL-decoded) or the body; null when Basic is malformed. */
function clientCredentials(c: Context, body: Record<string, string>): { clientId?: string; secret?: string } | null {
  const basic = c.req.header('authorization');
  if (!basic?.startsWith('Basic ')) return { clientId: body.client_id, secret: body.client_secret };
  const pair = Buffer.from(basic.slice(6), 'base64').toString('utf8');
  const i = pair.indexOf(':');
  if (i < 0) return null;
  try {
    return { clientId: decodeURIComponent(pair.slice(0, i)), secret: decodeURIComponent(pair.slice(i + 1)) };
  } catch {
    return null;
  }
}

export function registerOAuthRoutes(app: Hono, deps: AuthDeps): AuthState {
  const { cfg, signer } = deps;
  const state = deps.state ?? newAuthState();
  const clientDeps = { signer, cfg: cfg.auth, fetchCimd: deps.fetchCimd, cache: state.clients };

  // ---------- discovery
  const protectedResource = (c: Context) => {
    const iss = deps.issuer(c);
    return c.json({
      resource: resourceFor(iss),
      authorization_servers: [iss],
      scopes_supported: ALL_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'iMessage',
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  const authServer = (c: Context) => {
    const iss = deps.issuer(c);
    return c.json({
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      registration_endpoint: `${iss}/register`,
      revocation_endpoint: `${iss}/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt', 'client_secret_post', 'client_secret_basic'],
      token_endpoint_auth_signing_alg_values_supported: ['RS256', 'PS256', 'ES256'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [...ALL_SCOPES, 'offline_access'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  };
  app.get('/.well-known/oauth-authorization-server', authServer);
  app.get('/.well-known/openid-configuration', authServer);

  // ---------- dynamic client registration (RFC 7591)
  app.post('/register', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, 'invalid_client_metadata', 'Body must be JSON.');
    }
    try {
      return c.json(await registerClient(signer, cfg.auth, body), 201, NO_STORE);
    } catch (e) {
      if (e instanceof ClientError) return oauthError(c, e.code, e.message);
      throw e;
    }
  });

  // ---------- authorization endpoint
  app.get('/authorize', async (c) => {
    const q = c.req.query();
    let client: OAuthClient;
    try {
      client = await resolveClient(q.client_id ?? '', clientDeps);
    } catch (e) {
      return c.html(errorPage("Can't connect", e instanceof ClientError ? e.message : 'Unknown client.'), 400);
    }
    const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
    if (!redirectUri || !redirectMatches(redirectUri, client.redirectUris) || !redirectAllowed(redirectUri, cfg.auth)) {
      return c.html(errorPage("Can't connect", 'This app asked to return to an address that is not allowed.'), 400);
    }
    const iss = deps.issuer(c);
    const fail = (error: string, description: string) =>
      c.redirect(redirectWith(redirectUri, { error, error_description: description, state: q.state, iss }), 302);
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (!q.code_challenge || q.code_challenge_method !== 'S256')
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    if (!PKCE_VALUE.test(q.code_challenge))
      return fail('invalid_request', 'code_challenge must be 43-128 characters of A-Z a-z 0-9 . _ ~ -.');
    const resource = q.resource ?? resourceFor(iss);
    if (!acceptedAudiences(iss).includes(resource)) return fail('invalid_target', `Unknown resource ${resource}.`);
    let requested = parseScopes(q.scope);
    if (!requested.length) requested = [SCOPES.read];
    if (!requested.includes(SCOPES.read)) requested.unshift(SCOPES.read);
    const req = await signer.sign(
      'req',
      {
        cid: client.clientId,
        cn: client.name,
        ru: redirectUri,
        cc: q.code_challenge,
        st: q.state,
        sc: requested,
        res: resource,
      } satisfies AuthRequest,
      600,
    );
    return c.html(
      consentPage({
        req,
        clientName: client.name,
        redirectHost: new URL(redirectUri).host,
        loopback: isLoopback(redirectUri),
        requested,
      }),
      200,
      CONSENT_HEADERS,
    );
  });

  app.post('/authorize', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const one = (k: string) => {
      const v = form[k];
      return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;
    };
    const r = await signer.verify<AuthRequest>('req', one('req') ?? '');
    if (!r) return c.html(errorPage('Session expired', 'Go back to the app and connect again.'), 400);
    const iss = deps.issuer(c);
    if (one('action') === 'deny')
      return c.redirect(
        redirectWith(r.ru, { error: 'access_denied', error_description: 'The owner denied access.', state: r.st, iss }),
        302,
      );
    const render = (error: string, status: 401 | 429 = 401, headers: Record<string, string> = {}) =>
      c.html(
        consentPage({
          req: one('req')!,
          clientName: r.cn,
          redirectHost: new URL(r.ru).host,
          loopback: isLoopback(r.ru),
          requested: r.sc,
          error,
        }),
        status,
        { ...CONSENT_HEADERS, ...headers },
      );
    // From the throttle check to recording a failure there is no await, so parallel requests can't slip past it.
    const now = Date.now();
    const ipKey = `ip:${clientAddress(c)}`;
    const wait = Math.max(retryAfterSeconds(state, ipKey, now), retryAfterSeconds(state, GLOBAL, now));
    if (wait) return render(`Too many attempts. Try again in ${waitText(wait)}.`, 429, { 'Retry-After': String(wait) });
    if (!verifyPassword(one('password') ?? '', cfg.auth.ownerPasswordHash)) {
      recordFailure(state, [ipKey, GLOBAL], now);
      return render('Wrong password.');
    }
    const picked = new Set((Array.isArray(form.scope) ? form.scope : form.scope ? [form.scope] : []).map(String));
    const granted = r.sc.filter((s) => s === SCOPES.read || picked.has(s));
    const code = await signer.sign(
      'code',
      { jti: randomId(), cid: r.cid, ru: r.ru, cc: r.cc, sc: granted.join(' '), res: r.res } satisfies CodeClaims,
      300,
    );
    return c.redirect(redirectWith(r.ru, { code, state: r.st, iss }), 302);
  });

  // ---------- token endpoint
  const accessToken = (cid: string, scope: string, aud: string) =>
    signer.sign('at', { sub: 'owner', cid, scope, aud, ver: cfg.auth.tokenVersion }, cfg.auth.accessTtlS);

  /** Issues the next refresh token of a family; it becomes the only one that family accepts. */
  const rotate = async (fam: string, cid: string, scope: string, aud: string, prev?: string) => {
    const now = Date.now();
    const jti = randomId();
    const claims: RefreshClaims = { cid, sc: scope, aud, ver: cfg.auth.tokenVersion, fam, jti };
    const token = await signer.sign('rt', { sub: 'owner', ...claims }, cfg.auth.refreshTtlS);
    for (const [k, f] of state.families) if (f.at < now - cfg.auth.refreshTtlS * 1000) state.families.delete(k);
    state.families.set(fam, { jti, token, prev, at: now });
    return token;
  };

  const revokeFamily = (fam: string) => {
    const now = Date.now();
    for (const [k, t] of state.revokedFamilies)
      if (t < now - cfg.auth.refreshTtlS * 1000) state.revokedFamilies.delete(k);
    state.revokedFamilies.set(fam, now);
    state.families.delete(fam);
  };

  const tokenResponse = (c: Context, access: string, refresh: string, scope: string) =>
    c.json(
      { access_token: access, token_type: 'Bearer', expires_in: cfg.auth.accessTtlS, refresh_token: refresh, scope },
      200,
      NO_STORE,
    );

  app.post('/token', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    const raw = ct.includes('application/json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody();
    const body = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]),
    ) as Record<string, string>;
    const iss = deps.issuer(c);
    const auth = clientCredentials(c, body);
    if (!auth) return oauthError(c, 'invalid_client', 'Malformed Basic authorization header.', 401);
    let clientId = auth.clientId;
    const assertion = body.client_assertion;
    if (assertion && !clientId) {
      try {
        clientId = String(decodeJwt(assertion).iss ?? '');
      } catch {
        /* handled below */
      }
    }
    if (!clientId) return oauthError(c, 'invalid_client', 'client_id is required.', 401);
    let client: OAuthClient;
    try {
      client = await resolveClient(clientId, clientDeps);
    } catch (e) {
      return oauthError(c, 'invalid_client', e instanceof ClientError ? e.message : 'Unknown client.', 401);
    }
    if (assertion) {
      if (body.client_assertion_type !== ASSERTION_TYPE)
        return oauthError(c, 'invalid_client', 'Unsupported client_assertion_type.', 401);
      if (!(await verifyClientAssertion(client, assertion, [`${iss}/token`, iss], deps.fetchCimd, state.clients)))
        return oauthError(c, 'invalid_client', 'Client assertion could not be verified.', 401);
    } else if (client.authMethod === 'private_key_jwt')
      return oauthError(c, 'invalid_client', 'This client must authenticate with a client assertion.', 401);
    else if (!checkClientSecret(client, cfg.auth, auth.secret))
      return oauthError(c, 'invalid_client', 'Client authentication failed.', 401);

    if (body.grant_type === 'authorization_code') {
      const code = await signer.verify<CodeClaims>('code', body.code ?? '');
      const used = code && state.usedCodes.get(code.jti);
      // A code presented twice may have been intercepted, so whatever the first use issued is revoked too.
      if (used) revokeFamily(used.fam);
      if (!code || used)
        return oauthError(c, 'invalid_grant', 'The authorization code is invalid, expired or already used.');
      const fam = randomId();
      state.usedCodes.set(code.jti, { at: Date.now(), fam });
      for (const [k, u] of state.usedCodes) if (u.at < Date.now() - 600_000) state.usedCodes.delete(k);
      if (code.cid !== client.clientId) return oauthError(c, 'invalid_grant', 'Code was issued to another client.');
      if (body.redirect_uri && body.redirect_uri !== code.ru)
        return oauthError(c, 'invalid_grant', 'redirect_uri does not match.');
      const verifier = body.code_verifier ?? '';
      if (!PKCE_VALUE.test(verifier) || pkceS256(verifier) !== code.cc)
        return oauthError(c, 'invalid_grant', 'PKCE verification failed.');
      if (body.resource && body.resource !== code.res)
        return oauthError(c, 'invalid_target', 'resource does not match the authorization request.');
      const refresh = await rotate(fam, client.clientId, code.sc, code.res);
      return tokenResponse(c, await accessToken(client.clientId, code.sc, code.res), refresh, code.sc);
    }

    if (body.grant_type === 'refresh_token') {
      const rt = await signer.verify<RefreshClaims>('rt', body.refresh_token ?? '');
      if (!rt || rt.ver !== cfg.auth.tokenVersion || state.revokedFamilies.has(rt.fam))
        return oauthError(c, 'invalid_grant', 'The refresh token is invalid, expired or revoked.');
      if (rt.cid !== client.clientId)
        return oauthError(c, 'invalid_grant', 'Refresh token was issued to another client.');
      const narrowed = body.scope
        ? parseScopes(body.scope).filter((s) => rt.sc.split(' ').includes(s))
        : rt.sc.split(' ');
      const scope = narrowed.join(' ');
      // A family seen since this process started accepts only its newest token. After a restart the first token
      // presented takes over the family (the best a stateless server can do).
      const fam = state.families.get(rt.fam);
      if (fam && fam.jti !== rt.jti) {
        // The token just rotated out is a retry until its replacement is used: the client may never have received the
        // response (a dropped connection), so hand back the same replacement instead of signing it out.
        if (fam.prev === rt.jti)
          return tokenResponse(c, await accessToken(client.clientId, scope, rt.aud), fam.token, scope);
        // An older token came back after its replacement was used: someone else may hold a copy, so end the family.
        revokeFamily(rt.fam);
        return oauthError(c, 'invalid_grant', 'The refresh token was already used. Connect again.');
      }
      const refresh = await rotate(rt.fam, client.clientId, scope, rt.aud, rt.jti);
      return tokenResponse(c, await accessToken(client.clientId, scope, rt.aud), refresh, scope);
    }
    return oauthError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  // ---------- revocation (RFC 7009): ends the whole refresh family, in memory, until the next restart
  app.post('/revoke', async (c) => {
    const body = await c.req.parseBody();
    const rt = await signer.verify<RefreshClaims>('rt', String(body.token ?? ''));
    if (rt) revokeFamily(rt.fam);
    return c.body(null, 200);
  });

  return state;
}

export interface AccessGrant {
  scopes: Set<string>;
  clientId: string;
}

/** Verifies the bearer token for the MCP endpoint, or returns the 401 that starts sign-in. */
export async function checkBearer(c: Context, deps: AuthDeps): Promise<AccessGrant | Response> {
  const iss = deps.issuer(c);
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const claims = token
    ? await deps.signer.verify<{ scope: string; cid: string; ver: number }>('at', token, acceptedAudiences(iss))
    : null;
  if (claims && claims.ver === deps.cfg.auth.tokenVersion)
    return { scopes: new Set(claims.scope.split(' ')), clientId: claims.cid };
  const params = [`resource_metadata="${resourceMetadataUrl(iss)}"`, `scope="${ALL_SCOPES.join(' ')}"`];
  if (token) params.push('error="invalid_token"', 'error_description="The access token is invalid or expired"');
  return c.json(
    {
      error: token ? 'invalid_token' : 'unauthorized',
      error_description: token ? 'The access token is invalid or expired.' : 'Sign in to use this server.',
    },
    401,
    { 'WWW-Authenticate': `Bearer ${params.join(', ')}` },
  );
}
