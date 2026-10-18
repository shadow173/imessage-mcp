import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import type { AuthConfig } from '../config.js';
import { HOUR_MS } from '../lib/units.js';
import { hmac, type Signer, safeEqual } from './crypto.js';

export type TokenAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic' | 'private_key_jwt';

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  kind: 'dcr' | 'cimd';
  /** private_key_jwt: a CIMD client that declared it (or published keys) and must send a signed assertion. */
  authMethod: TokenAuthMethod;
  /** Where a private_key_jwt client publishes its keys, e.g. ChatGPT. Unset when the host isn't allowed. */
  jwksUri?: string;
}

/** Per-app caches: two apps in one process (tests) never share client state. */
export interface ClientCache {
  cimd: Map<string, { client: OAuthClient; until: number }>;
  jwks: Map<string, { keys: ReturnType<typeof createLocalJWKSet>; until: number }>;
  /** client_id:jti of verified assertions until they expire, so each one works once. */
  usedAssertions: Map<string, number>;
}
export const newClientCache = (): ClientCache => ({ cimd: new Map(), jwks: new Map(), usedAssertions: new Map() });

/** DCR client secrets derive from the signing secret, so rotating LINK_SECRET (to kill shared links) keeps clients. */
const clientSecret = (cfg: AuthConfig, clientId: string) => hmac(cfg.signingSecret, `client-secret:${clientId}`);

const BUILTIN_EXACT = [
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];
const CHATGPT_CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Server-wide allowlist: ChatGPT, Claude, Claude Code loopback on any port, plus env extras. */
export function redirectAllowed(uri: string, cfg: AuthConfig): boolean {
  return (
    BUILTIN_EXACT.includes(uri) || CHATGPT_CALLBACK.test(uri) || isLoopback(uri) || cfg.extraRedirectUris.includes(uri)
  );
}

/** Exact match, except loopback URIs match with the port ignored (RFC 8252 §7.3). */
export function redirectMatches(uri: string, registered: string[]): boolean {
  if (registered.includes(uri)) return true;
  if (!isLoopback(uri)) return false;
  const u = new URL(uri);
  return registered.some((r) => {
    if (!isLoopback(r)) return false;
    const v = new URL(r);
    return v.hostname === u.hostname && v.pathname === u.pathname;
  });
}

export class ClientError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** DCR client ids are signed tokens holding the registration, so they survive restarts with no storage. */
export async function registerClient(signer: Signer, cfg: AuthConfig, body: Record<string, unknown>) {
  const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]).map(String) : [];
  if (!redirectUris.length) throw new ClientError('invalid_redirect_uri', 'redirect_uris is required.');
  const bad = redirectUris.filter((u) => !redirectAllowed(u, cfg));
  if (bad.length) throw new ClientError('invalid_redirect_uri', `Redirect URI not allowed: ${bad.join(', ')}`);
  const method = (body.token_endpoint_auth_method as TokenAuthMethod | undefined) ?? 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method))
    throw new ClientError('invalid_client_metadata', `Unsupported token_endpoint_auth_method ${method}.`);
  const name = String(body.client_name ?? 'MCP client').slice(0, 80);
  // n: client name, r: redirect URIs, m: token endpoint auth method. Short keys keep client ids short.
  const clientId = await signer.sign('client', { n: name, r: redirectUris, m: method }, null);
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    ...(method === 'none' ? {} : { client_secret: clientSecret(cfg, clientId), client_secret_expires_at: 0 }),
  };
}

export type CimdFetcher = (url: string) => Promise<unknown>;

export const defaultCimdFetcher: CimdFetcher = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 64_000) throw new Error('document too large');
  return JSON.parse(text);
};

const parseUrl = (s: string) => {
  try {
    return new URL(s);
  } catch {
    return null;
  }
};

export async function resolveClient(
  clientId: string,
  deps: { signer: Signer; cfg: AuthConfig; fetchCimd: CimdFetcher; cache: ClientCache },
): Promise<OAuthClient> {
  if (/^https?:\/\//.test(clientId)) {
    const u = parseUrl(clientId);
    if (!u) throw new ClientError('invalid_client', 'Client metadata URL is not a valid URL.');
    const insecureOk = deps.cfg.allowInsecureCimd && u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
    if (u.protocol !== 'https:' && !insecureOk)
      throw new ClientError('invalid_client', 'Client metadata URL must be https.');
    if (!insecureOk && !deps.cfg.cimdHosts.includes(u.hostname))
      throw new ClientError('invalid_client', `Client metadata host ${u.hostname} is not allowed.`);
    const hit = deps.cache.cimd.get(clientId);
    if (hit && hit.until > Date.now()) return hit.client;
    let doc: Record<string, unknown>;
    try {
      doc = (await deps.fetchCimd(clientId)) as Record<string, unknown>;
    } catch (e) {
      throw new ClientError('invalid_client', `Couldn't fetch client metadata: ${(e as Error).message}`);
    }
    if (doc?.client_id !== clientId)
      throw new ClientError('invalid_client', 'Client metadata client_id does not match its URL.');
    const redirectUris = Array.isArray(doc.redirect_uris) ? (doc.redirect_uris as unknown[]).map(String) : [];
    if (!redirectUris.length) throw new ClientError('invalid_client', 'Client metadata has no redirect_uris.');
    let jwksUri: string | undefined;
    const j = typeof doc.jwks_uri === 'string' ? parseUrl(doc.jwks_uri) : null;
    if (
      j &&
      ((j.protocol === 'https:' && deps.cfg.cimdHosts.includes(j.hostname)) ||
        (insecureOk && LOOPBACK_HOSTS.has(j.hostname)))
    )
      jwksUri = j.toString();
    // A client that signs assertions must always sign them: leaving the assertion out is not a fallback to "none".
    const signs = doc.token_endpoint_auth_method === 'private_key_jwt' || typeof doc.jwks_uri === 'string';
    const client: OAuthClient = {
      clientId,
      name: String(doc.client_name ?? u.hostname),
      redirectUris,
      kind: 'cimd',
      authMethod: signs ? 'private_key_jwt' : 'none',
      jwksUri,
    };
    deps.cache.cimd.set(clientId, { client, until: Date.now() + HOUR_MS });
    return client;
  }
  const p = await deps.signer.verify<{ n: string; r: string[]; m: TokenAuthMethod }>('client', clientId);
  if (!p) throw new ClientError('invalid_client', 'Unknown client_id. Register again.');
  return { clientId, name: p.n, redirectUris: p.r, kind: 'dcr', authMethod: p.m ?? 'none' };
}

export const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** RFC 7523 private_key_jwt: verifies a client assertion against the client's published JWKS. */
export async function verifyClientAssertion(
  client: OAuthClient,
  assertion: string,
  audiences: string[],
  fetchJson: CimdFetcher,
  cache: ClientCache,
): Promise<boolean> {
  if (!client.jwksUri) return false;
  let entry = cache.jwks.get(client.jwksUri);
  if (!entry || entry.until < Date.now()) {
    try {
      entry = {
        keys: createLocalJWKSet((await fetchJson(client.jwksUri)) as JSONWebKeySet),
        until: Date.now() + HOUR_MS,
      };
    } catch {
      return false;
    }
    cache.jwks.set(client.jwksUri, entry);
  }
  try {
    const { payload } = await jwtVerify(assertion, entry.keys, {
      issuer: client.clientId,
      subject: client.clientId,
      audience: audiences,
      algorithms: ['RS256', 'PS256', 'ES256'],
      maxTokenAge: '10m',
    });
    if (!payload.exp || !payload.jti) return false;
    const now = Date.now();
    for (const [k, t] of cache.usedAssertions) if (t < now) cache.usedAssertions.delete(k);
    const key = `${client.clientId}:${payload.jti}`;
    if (cache.usedAssertions.has(key)) return false;
    cache.usedAssertions.set(key, payload.exp * 1000);
    return true;
  } catch {
    return false;
  }
}

/** For clients that don't send an assertion. A private_key_jwt client never passes here. */
export function checkClientSecret(client: OAuthClient, cfg: AuthConfig, presented: string | undefined): boolean {
  if (client.authMethod === 'none') return true;
  if (client.authMethod === 'private_key_jwt') return false;
  return !!presented && safeEqual(presented, clientSecret(cfg, client.clientId));
}
