import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { liveClockMockStore } from './helpers/mock.js';
import {
  authorize,
  cheapPasswordHash,
  consent,
  type Fetcher,
  LOOPBACK_REDIRECT,
  register,
  token,
} from './helpers/oauth.js';

const PASSWORD = 'oauth test password';
const ISS = 'https://imessage.example';
const HASH = cheapPasswordHash(PASSWORD);

/** A production gateway in mock mode, run in-process with Hono's app.request. Each call starts with fresh state. */
function gateway(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    MODE: 'mock',
    PUBLIC_URL: ISS,
    AUTH_SIGNING_SECRET: 'oauth-test-signing-secret-0123456789',
    OWNER_PASSWORD_HASH: HASH,
    OWNER_TZ: 'America/New_York',
    ...env,
  } as NodeJS.ProcessEnv);
  const { app, authState } = createApp(cfg, { store: liveClockMockStore() });
  const f: Fetcher = async (path, init) => app.request(path, init);
  return { f, authState };
}
const mcp = (f: Fetcher, accessToken: string) =>
  f('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
const refresh = (f: Fetcher, clientId: string, refreshToken: string) =>
  token(f, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
/** Moves every recorded password failure ms into the past, as if that much time went by. */
const age = (state: ReturnType<typeof gateway>['authState'], ms: number) => {
  for (const [k, list] of state.failures)
    state.failures.set(
      k,
      list.map((t) => t - ms),
    );
};

describe('consent page', () => {
  it('deny sends access_denied back to the client with its state and our issuer', async () => {
    const { f } = gateway();
    const { client_id } = await register(f);
    const { res } = await consent(f, { clientId: client_id, password: '', action: 'deny' });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location')!);
    assert.equal(loc.origin + loc.pathname, LOOPBACK_REDIRECT);
    assert.deepEqual(
      [loc.searchParams.get('error'), loc.searchParams.get('state'), loc.searchParams.get('iss')],
      ['access_denied', 'st8', ISS],
    );
    assert.equal(loc.searchParams.get('code'), null);
  });

  it('refuses a bad PKCE challenge, a plain method and an unknown resource with a redirect error', async () => {
    const { f } = gateway();
    const { client_id } = await register(f);
    for (const [query, error] of [
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ code_challenge: `${'a'.repeat(42)}!` }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ resource: 'https://evil.example/mcp' }, 'invalid_target'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ] as const) {
      const { res } = await consent(f, { clientId: client_id, password: PASSWORD, query });
      assert.equal(res.status, 302, JSON.stringify(query));
      assert.equal(new URL(res.headers.get('location')!).searchParams.get('error'), error, JSON.stringify(query));
    }
  });

  it('refuses unknown clients, malformed metadata URLs and unregistered redirects with a page, not a 500', async () => {
    const { f } = gateway();
    const { client_id } = await register(f);
    for (const [clientId, redirect] of [
      ['not-a-client-id', LOOPBACK_REDIRECT],
      ['https://[not-a-url', LOOPBACK_REDIRECT],
      ['http://chatgpt.com/oauth/client.json', LOOPBACK_REDIRECT],
      ['https://evil.example/client.json', LOOPBACK_REDIRECT],
      [client_id, 'http://127.0.0.1:9999/elsewhere'],
    ])
      assert.equal((await consent(f, { clientId, redirect, password: PASSWORD })).res.status, 400, clientId);
  });
});

describe('password throttling', () => {
  it('gives an address 5 tries, then makes it wait, doubling; the right password waits too', async () => {
    const { f, authState } = gateway();
    const { client_id } = await register(f);
    const tryAs = (forwardedFor: string, password: string) =>
      consent(f, { clientId: client_id, password, forwardedFor }).then((r) => r.res);
    for (let i = 0; i < 5; i++) assert.equal((await tryAs('203.0.113.7', 'nope')).status, 401);
    const blocked = await tryAs('203.0.113.7', PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '30');
    assert.match(await blocked.text(), /Too many attempts\. Try again in 30 s\./);
    // The throttle keys on the address the proxy appended (right-most), so a forged left-most entry doesn't help.
    assert.equal((await tryAs('198.51.100.9, 203.0.113.7', PASSWORD)).status, 429);
    assert.equal((await tryAs('203.0.113.7, 198.51.100.9', PASSWORD)).status, 302, 'another address is unaffected');
    age(authState, 31_000);
    assert.equal((await tryAs('203.0.113.7', 'nope')).status, 401);
    assert.equal((await tryAs('203.0.113.7', PASSWORD)).headers.get('retry-after'), '60');
    age(authState, 61_000);
    assert.equal((await tryAs('203.0.113.7', PASSWORD)).status, 302, 'never locked out for longer than one wait');
  });

  it('spaces attempts from everywhere once 20 fail in 15 minutes, without a lockout', async () => {
    const { f, authState } = gateway();
    const { client_id } = await register(f);
    for (let i = 1; i <= 20; i++)
      assert.equal(
        (await consent(f, { clientId: client_id, password: 'nope', forwardedFor: `198.51.100.${i}` })).res.status,
        401,
      );
    const fresh = (await consent(f, { clientId: client_id, password: PASSWORD, forwardedFor: '192.0.2.1' })).res;
    assert.equal(fresh.status, 429);
    assert.equal(fresh.headers.get('retry-after'), '45');
    age(authState, 46_000);
    assert.equal(
      (await consent(f, { clientId: client_id, password: PASSWORD, forwardedFor: '192.0.2.1' })).res.status,
      302,
    );
    age(authState, 15 * 60_000);
    await consent(f, { clientId: client_id, password: 'nope', forwardedFor: '192.0.2.2' });
    assert.deepEqual([...authState.failures.keys()].sort(), ['global', 'ip:192.0.2.2'], 'old failures are pruned');
  });
});

describe('token endpoint', () => {
  it('ties a code to its client, redirect_uri and resource', async () => {
    const { f } = gateway();
    const a = await register(f, { client_name: 'Client A' });
    const b = await register(f, { client_name: 'Client B' });
    const cases: [Record<string, string>, string, RegExp][] = [
      [{ client_id: b.client_id }, 'invalid_grant', /issued to another client/],
      [{ redirect_uri: 'http://127.0.0.1:8976/other' }, 'invalid_grant', /redirect_uri does not match/],
      [{ resource: 'https://evil.example/mcp' }, 'invalid_target', /resource does not match/],
      [{ code_verifier: 'short' }, 'invalid_grant', /PKCE verification failed/],
    ];
    for (const [tokenParams, error, description] of cases) {
      const r = await authorize(f, { clientId: a.client_id, password: PASSWORD, tokenParams });
      assert.equal(r.status, 400, JSON.stringify(tokenParams));
      assert.equal(r.json.error, error);
      assert.match(r.json.error_description, description);
    }
  });

  it('rotates refresh tokens: the previous token is a retry until its replacement is used, then reuse ends the family', async () => {
    const { f, authState } = gateway();
    const { client_id } = await register(f);
    const first = (await authorize(f, { clientId: client_id, password: PASSWORD })).json;
    const r2 = await refresh(f, client_id, first.refresh_token);
    assert.equal(r2.status, 200);
    assert.notEqual(r2.json.refresh_token, first.refresh_token);
    // The client never got r2 (a dropped response) and retries much later: it gets r2 again, not a sign-out.
    for (const fam of authState.families.values()) fam.at -= 60 * 60_000;
    const retry = await refresh(f, client_id, first.refresh_token);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.refresh_token, r2.json.refresh_token);
    // Once r2 is used, the first token is two generations old: presenting it ends the whole family.
    const r3 = await refresh(f, client_id, r2.json.refresh_token);
    assert.equal(r3.status, 200);
    const reuse = await refresh(f, client_id, first.refresh_token);
    assert.equal(reuse.json.error, 'invalid_grant');
    assert.match(reuse.json.error_description, /already used/);
    assert.equal((await refresh(f, client_id, r3.json.refresh_token)).json.error, 'invalid_grant');
  });

  it('a reused authorization code is refused and ends the sign-in its first use started', async () => {
    const { f } = gateway();
    const { client_id } = await register(f);
    const first = await authorize(f, { clientId: client_id, password: PASSWORD });
    assert.equal(first.status, 200);
    const again = await token(f, {
      grant_type: 'authorization_code',
      code: first.code,
      client_id,
      code_verifier: first.verifier,
      redirect_uri: LOOPBACK_REDIRECT,
    });
    assert.equal(again.json.error, 'invalid_grant');
    assert.match(again.json.error_description, /already used/);
    assert.equal((await refresh(f, client_id, first.json.refresh_token)).json.error, 'invalid_grant');
  });

  it('refuses a refresh token from another client and narrows scopes only', async () => {
    const { f } = gateway();
    const a = await register(f, { client_name: 'Client A' });
    const b = await register(f, { client_name: 'Client B' });
    const t = (await authorize(f, { clientId: a.client_id, password: PASSWORD })).json;
    const other = await refresh(f, b.client_id, t.refresh_token);
    assert.equal(other.json.error, 'invalid_grant');
    assert.match(other.json.error_description, /issued to another client/);
    const narrowed = await token(f, {
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: a.client_id,
      scope: 'messages.read messages.organize',
    });
    assert.equal(narrowed.json.scope, 'messages.read', 'organize was never granted, so it is not added');
  });

  it('/revoke ends the refresh family', async () => {
    const { f } = gateway();
    const { client_id } = await register(f);
    const t = (await authorize(f, { clientId: client_id, password: PASSWORD })).json;
    const rotated = (await refresh(f, client_id, t.refresh_token)).json;
    const res = await f('/revoke', { method: 'POST', body: new URLSearchParams({ token: rotated.refresh_token }) });
    assert.equal(res.status, 200);
    assert.equal((await refresh(f, client_id, rotated.refresh_token)).json.error, 'invalid_grant');
    assert.equal((await refresh(f, client_id, t.refresh_token)).json.error, 'invalid_grant');
    assert.equal((await f('/revoke', { method: 'POST', body: new URLSearchParams({ token: 'junk' }) })).status, 200);
  });

  it('bumping TOKEN_VERSION revokes every access and refresh token', async () => {
    const v1 = gateway();
    const { client_id } = await register(v1.f);
    const t = (await authorize(v1.f, { clientId: client_id, password: PASSWORD })).json;
    assert.equal((await mcp(v1.f, t.access_token)).status, 200);
    const v2 = gateway({ TOKEN_VERSION: '2' });
    const res = await mcp(v2.f, t.access_token);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate')!, /error="invalid_token"/);
    assert.equal((await refresh(v2.f, client_id, t.refresh_token)).json.error, 'invalid_grant');
    assert.equal((await refresh(v1.f, client_id, t.refresh_token)).status, 200, 'the same token, before the bump');
  });

  it('confidential clients: client_secret_post and client_secret_basic, each checked', async () => {
    const { f } = gateway();
    const post = await register(f, { token_endpoint_auth_method: 'client_secret_post' });
    assert.ok(post.client_secret);
    const flow = async (tokenParams: Record<string, string>, clientId = post.client_id) =>
      authorize(f, { clientId, password: PASSWORD, tokenParams });
    assert.equal((await flow({})).status, 401, 'no secret');
    assert.equal((await flow({ client_secret: 'wrong' })).json.error, 'invalid_client');
    assert.equal((await flow({ client_secret: post.client_secret! })).status, 200);

    const basic = await register(f, { token_endpoint_auth_method: 'client_secret_basic' });
    const header = (id: string, secret: string) => ({
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`,
    });
    const viaBasic = async (headers: Record<string, string>) => {
      const { res, verifier } = await consent(f, { clientId: basic.client_id, password: PASSWORD });
      const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
      return token(
        f,
        { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: LOOPBACK_REDIRECT },
        headers,
      );
    };
    assert.equal((await viaBasic(header(basic.client_id, basic.client_secret!))).status, 200);
    assert.equal((await viaBasic(header(basic.client_id, 'wrong'))).status, 401);
    for (const bad of [
      'Basic !!!',
      `Basic ${Buffer.from('no-colon').toString('base64')}`,
      `Basic ${Buffer.from('%E0%A4%A:x').toString('base64')}`,
    ]) {
      const r = await viaBasic({ authorization: bad });
      assert.equal(r.status, 401, bad);
      assert.equal(r.json.error, 'invalid_client');
    }
  });

  it('client secrets survive a LINK_SECRET rotation (they derive from the signing secret)', async () => {
    const before = gateway({ LINK_SECRET: 'link-secret-one-0123456789abcdefgh' });
    const c = await register(before.f, { token_endpoint_auth_method: 'client_secret_post' });
    const after = gateway({ LINK_SECRET: 'link-secret-two-0123456789abcdefgh' });
    const r = await authorize(after.f, {
      clientId: c.client_id,
      password: PASSWORD,
      tokenParams: { client_secret: c.client_secret! },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  it('refuses unknown grant types and garbage tokens', async () => {
    const { f } = gateway();
    const { client_id } = await register(f);
    assert.equal((await token(f, { grant_type: 'password', client_id })).json.error, 'unsupported_grant_type');
    assert.equal((await refresh(f, client_id, 'garbage')).json.error, 'invalid_grant');
    assert.equal((await token(f, { grant_type: 'authorization_code', code: 'x' })).status, 401, 'no client_id');
  });
});
