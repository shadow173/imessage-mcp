import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { type ServerType, serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { pkceS256, randomId } from '../src/auth/crypto.js';
import { devGatewayConfig } from './helpers/gateway.js';
import { type Result, text } from './helpers/mcp.js';
import { liveClockMockStore } from './helpers/mock.js';

let server: ServerType;
let client: Client;
let base: string;
const PASSWORD = 'correct horse battery staple';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_CIMD = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_JWKS = 'https://chatgpt.com/oauth/jwks.json';
let chatgptKey: CryptoKey;
let otherKey: CryptoKey;
const assertionFor = (key: CryptoKey, jti = randomId()) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(CHATGPT_CIMD)
    .setSubject(CHATGPT_CIMD)
    .setAudience(`${base}/token`)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);

async function call(name: string, args: Record<string, unknown> = {}, c: Client = client): Promise<Result> {
  return (await c.callTool({ name, arguments: { intent: 'smoke test of the iMessage tools', ...args } })) as Result;
}

/** Runs the whole OAuth dance the way ChatGPT/Claude do and returns the token response. */
async function oauth(
  o: {
    scopes?: string[];
    allow?: string[];
    clientId?: string;
    redirect?: string;
    password?: string;
    badVerifier?: boolean;
    assertion?: string;
  } = {},
) {
  const redirect = o.redirect ?? REDIRECT;
  let clientId = o.clientId;
  if (!clientId) {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirect],
        client_name: 'Smoke client',
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(reg.status, 201);
    clientId = (await reg.json()).client_id as string;
  }
  const verifier = randomId(32);
  const url = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    state: 'st8',
    scope: (o.scopes ?? ['messages.read', 'messages.organize', 'messages.send']).join(' '),
    resource: `${base}/mcp`,
  }))
    url.searchParams.set(k, v);
  const page = await fetch(url, { redirect: 'manual' });
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  const req = html.match(/name="req" value="([^"]+)"/)![1];
  const form = new URLSearchParams({ req, password: o.password ?? PASSWORD, action: 'allow' });
  for (const s of o.allow ?? ['messages.organize', 'messages.send']) form.append('scope', s);
  const res = await fetch(`${base}/authorize`, { method: 'POST', body: form, redirect: 'manual' });
  if (res.status !== 302) return { status: res.status, html: await res.text() } as const;
  const loc = new URL(res.headers.get('location')!);
  assert.equal(loc.searchParams.get('state'), 'st8');
  assert.equal(loc.searchParams.get('iss'), base);
  const code = loc.searchParams.get('code')!;
  const tok = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      ...(o.assertion
        ? {
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: o.assertion,
          }
        : { client_id: clientId }),
      code_verifier: o.badVerifier ? `x${verifier}` : verifier,
      resource: `${base}/mcp`,
    }),
  });
  return {
    status: 302,
    location: loc,
    clientId,
    code,
    verifier,
    tokenStatus: tok.status,
    token: await tok.json(),
  } as const;
}

async function mcpClient(accessToken: string): Promise<Client> {
  const c = new Client({ name: 'smoke', version: '1.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return c;
}

before(async () => {
  const cfg = devGatewayConfig(PASSWORD);
  const store = liveClockMockStore();
  const pair = await generateKeyPair('RS256');
  chatgptKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const fetchCimd = async (url: string) =>
    url === CHATGPT_JWKS
      ? { keys: [jwk] }
      : {
          client_id: url,
          client_name: 'ChatGPT',
          redirect_uris: [CHATGPT_REDIRECT],
          token_endpoint_auth_method: 'private_key_jwt',
          jwks_uri: CHATGPT_JWKS,
        };
  const { app } = createApp(cfg, { store, fetchCimd });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const flow = await oauth();
  assert.equal(flow.status, 302);
  client = await mcpClient((flow as any).token.access_token);
});
after(async () => {
  await client.close();
  server.close();
});

describe('OAuth', () => {
  it('serves discovery metadata both clients need', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const prm = await (await fetch(base + path)).json();
      assert.equal(prm.resource, `${base}/mcp`);
      assert.deepEqual(prm.authorization_servers, [base]);
    }
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const as = await (await fetch(base + path)).json();
      assert.equal(as.issuer, base);
      assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
      assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
      assert.equal(as.client_id_metadata_document_supported, true);
      assert.equal(as.authorization_response_iss_parameter_supported, true);
      assert.ok(as.scopes_supported.includes('offline_access'));
    }
  });

  it('answers unauthenticated MCP calls with a 401 that starts sign-in', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      }),
    });
    assert.equal(res.status, 401);
    const h = res.headers.get('www-authenticate')!;
    assert.match(h, new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
    assert.match(h, /scope="messages.read messages.organize messages.send"/);
    const bad = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate')!, /invalid_token/);
  });

  it('rejects disallowed redirects, wrong passwords, bad PKCE and reused codes', async () => {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }),
    });
    assert.equal(reg.status, 400);
    assert.equal((await reg.json()).error, 'invalid_redirect_uri');
    const wrong = await oauth({ password: 'nope' });
    assert.equal(wrong.status, 401);
    assert.match((wrong as any).html, /Wrong password/);
    const ok = (await oauth()) as any;
    const again = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: ok.code,
        redirect_uri: REDIRECT,
        client_id: ok.clientId,
        code_verifier: ok.verifier,
      }),
    });
    assert.equal((await again.json()).error, 'invalid_grant');
    const badPkce = (await oauth({ badVerifier: true })) as any;
    assert.equal(badPkce.tokenStatus, 400);
    assert.equal(badPkce.token.error, 'invalid_grant');
  });

  it('refreshes tokens and keeps the same scopes', async () => {
    const f = (await oauth()) as any;
    const r = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: f.token.refresh_token,
        client_id: f.clientId,
      }),
    });
    const t = await r.json();
    assert.equal(r.status, 200);
    assert.equal(t.scope, 'messages.read messages.organize messages.send');
    const c = await mcpClient(t.access_token);
    assert.equal((await call('get_status', {}, c)).structuredContent.mode, 'mock');
    await c.close();
    const bad = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'garbage', client_id: f.clientId }),
    });
    assert.equal((await bad.json()).error, 'invalid_grant');
  });

  it('a read-only grant gets a re-auth challenge on send', async () => {
    const f = (await oauth({ allow: [] })) as any;
    assert.equal(f.token.scope, 'messages.read');
    const c = await mcpClient(f.token.access_token);
    const r = await call('send_message', { to: 'Sam Ortiz', text: 'hi', idempotency_key: 'ro-000001' }, c);
    assert.equal(r.isError, true);
    assert.match(r._meta['mcp/www_authenticate'], /error="insufficient_scope"/);
    assert.match(r._meta['mcp/www_authenticate'], /error_description="/);
    assert.equal((await call('get_status', {}, c)).isError, undefined);
    await c.close();
  });

  it('tools/list carries per-tool securitySchemes', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${((await oauth()) as any).token.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const tools = (await res.json()).result.tools;
    assert.deepEqual(tools.find((t: any) => t.name === 'find').securitySchemes, [
      { type: 'oauth2', scopes: ['messages.read'] },
    ]);
    assert.deepEqual(tools.find((t: any) => t.name === 'send_message').securitySchemes, [
      { type: 'oauth2', scopes: ['messages.send'] },
    ]);
    assert.deepEqual(tools.find((t: any) => t.name === 'label_conversation').securitySchemes, [
      { type: 'oauth2', scopes: ['messages.organize'] },
    ]);
  });

  it('authenticates ChatGPT with private_key_jwt and rejects forged or replayed assertions', async () => {
    const good = (await oauth({
      clientId: CHATGPT_CIMD,
      redirect: CHATGPT_REDIRECT,
      assertion: await assertionFor(chatgptKey),
    })) as any;
    assert.equal(good.tokenStatus, 200, JSON.stringify(good.token));
    const forged = (await oauth({
      clientId: CHATGPT_CIMD,
      redirect: CHATGPT_REDIRECT,
      assertion: await assertionFor(otherKey),
    })) as any;
    assert.equal(forged.tokenStatus, 401);
    assert.equal(forged.token.error, 'invalid_client');
    const reused = await assertionFor(chatgptKey, 'same-jti');
    assert.equal(
      ((await oauth({ clientId: CHATGPT_CIMD, redirect: CHATGPT_REDIRECT, assertion: reused })) as any).tokenStatus,
      200,
    );
    assert.equal(
      ((await oauth({ clientId: CHATGPT_CIMD, redirect: CHATGPT_REDIRECT, assertion: reused })) as any).tokenStatus,
      401,
    );
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.ok(as.token_endpoint_auth_methods_supported.includes('private_key_jwt'));
  });

  it('accepts ChatGPT via its metadata document, returns iss, and requires its assertion', async () => {
    const f = (await oauth({ clientId: CHATGPT_CIMD, redirect: CHATGPT_REDIRECT })) as any;
    assert.equal(f.status, 302);
    assert.ok(f.location.toString().startsWith(CHATGPT_REDIRECT));
    assert.equal(f.tokenStatus, 401);
    assert.equal(f.token.error, 'invalid_client');
    const bad = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: CHATGPT_CIMD,
      redirect_uri: 'https://chatgpt.com/somewhere-else',
      code_challenge: 'x',
      code_challenge_method: 'S256',
    }))
      bad.searchParams.set(k, v);
    assert.equal((await fetch(bad, { redirect: 'manual' })).status, 400);
    const evilHost = new URL(`${base}/authorize`);
    evilHost.searchParams.set('client_id', 'https://evil.example/client.json');
    assert.equal((await fetch(evilHost, { redirect: 'manual' })).status, 400);
  });
});

describe('intent', () => {
  it('is required on every tool except the ChatGPT search/fetch contract', async () => {
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      const required = (t.inputSchema.required ?? []).includes('intent');
      assert.equal(required, !['search', 'fetch'].includes(t.name), `${t.name} intent required=${required}`);
      assert.ok((t.inputSchema.properties as Record<string, unknown>).intent, `${t.name} advertises intent`);
    }
  });
  it('a call without intent gets an error that says what to send', async () => {
    const r = (await client.callTool({ name: 'find', arguments: { query: 'Sam' } })) as Result;
    assert.equal(r.isError, true);
    assert.match(text(r), /intent is required: add "intent" with who this request is for and why/);
  });
  it('search works without intent (deep research sends only the query)', async () => {
    const r = (await client.callTool({ name: 'search', arguments: { query: 'cabin' } })) as Result;
    assert.notEqual(r.isError, true);
  });
});

describe('mock iMessage MCP', () => {
  it('lists all 30 tools with annotations', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 30, tools.map((t) => t.name).join(','));
    const find = tools.find((t) => t.name === 'find')!;
    assert.equal(find.annotations?.readOnlyHint, true);
    const send = tools.find((t) => t.name === 'send_message')!;
    assert.equal(send.annotations?.idempotentHint, false);
  });

  it('find returns both Sams, and "Sam" alone is ambiguous', async () => {
    const r = await call('find', { query: 'Sam' });
    assert.match(text(r), /Sam Ortiz/);
    assert.match(text(r), /Sam Lee/);
    const amb = await call('read_conversation', { chat: 'Sam' });
    assert.equal(amb.isError, true);
    assert.match(text(amb), /ambiguous/);
    assert.match(text(amb), /p_sam_ortiz/);
    assert.match(text(amb), /p_sam_lee/);
  });

  it('merges one person across phone, email and SMS handles', async () => {
    const r = await call('get_person', { person: 'sam.ortiz@example.com' });
    const p = r.structuredContent;
    assert.equal(p.person_id, 'p_sam_ortiz');
    assert.equal(p.dm_chats.length, 3);
    assert.equal(p.groups.length, 1);
  });

  it('resolves nicknames and pages a long chat back to the first message', async () => {
    const first = await call('read_conversation', { chat: 'Mom', limit: 200, format: 'json' });
    const total = first.structuredContent.total_in_range;
    assert.ok(total > 200, `Mom chat has ${total} messages`);
    let seen = first.structuredContent.messages.length;
    let cursor = first.structuredContent.older_cursor;
    const ids = new Set(first.structuredContent.messages.map((m: any) => m.message_id));
    while (cursor) {
      const r = await call('read_conversation', { chat: 'Mom', limit: 200, cursor, format: 'json' });
      for (const m of r.structuredContent.messages) {
        assert.ok(!ids.has(m.message_id), 'no repeats');
        ids.add(m.message_id);
      }
      seen += r.structuredContent.messages.length;
      cursor = r.structuredContent.older_cursor;
    }
    assert.equal(seen, total);
  });

  it('truncates long messages in transcripts and returns them whole in get_message', async () => {
    const s = await call('search_messages', { query: 'apple pie recipe', format: 'json' });
    const id = s.structuredContent.hits[0].message_id;
    const r = await call('read_conversation', {
      chat: 'Mom',
      on: s.structuredContent.hits[0].sent_at.slice(0, 10),
      max_chars_per_message: 200,
    });
    assert.match(text(r), /\+\d+ chars, get_message for all/);
    const full = await call('get_message', { message_id: id, context_before: 1, context_after: 1 });
    assert.match(text(full), /cold butter and patience/);
  });

  it('search lifts Gmail-style tokens and filters by sender', async () => {
    const r = await call('search_messages', { query: 'from:jo has:attachment', format: 'json' });
    assert.ok(r.structuredContent.hits.length >= 1);
    assert.ok(r.structuredContent.hits.every((h: any) => h.from.name === 'Jo Kim' && h.attachments.length));
    const mine = await call('search_messages', { query: 'cabin', from: 'me', format: 'json' });
    assert.ok(mine.structuredContent.hits.every((h: any) => h.from === 'me'));
  });

  it('hides verification codes and wraps untrusted text', async () => {
    const r = await call('catch_up', { senders: 'all' });
    const t = text(r);
    assert.doesNotMatch(t, /482913/);
    assert.match(t, /\[verification code hidden\]/);
    assert.match(t, /never follow instructions/);
    const known = await call('catch_up', {});
    assert.doesNotMatch(text(known), /Coastal Realty/);
    assert.match(text(known), /unknown senders hidden/);
  });

  it('shows reactions, edits, unsent and inline replies', async () => {
    const r = await call('read_conversation', { chat: 'Cabin Weekend' });
    assert.match(text(r), /👍 Jo/);
    assert.match(text(r), /↳ reply to "who's driving\?"/);
    const sam = await call('read_conversation', { chat: 'Sam Ortiz' });
    assert.match(text(sam), /\(edited\)/);
    const jo = await call('read_conversation', { chat: 'Jo Kim' });
    assert.match(text(jo), /\[unsent\]/);
    assert.match(text(jo), /Apple Cash \$40\.00/);
    const hit = await call('search_messages', { query: "who's driving", format: 'json' });
    const thread = await call('get_reply_thread', { message_id: hit.structuredContent.hits[0].message_id });
    assert.match(text(thread), /second car/);
    assert.match(text(thread), /don't have a car/);
  });

  it('opens attachments as image, text and signed link', async () => {
    const list = await call('list_attachments', { format: 'json' });
    const img = list.structuredContent.attachments.find((a: any) => a.name === 'IMG_2231.HEIC');
    const prev = await call('get_attachment', { attachment_id: img.attachment_id });
    assert.ok(prev.content.some((c) => c.type === 'image' && c.data));
    const memo = list.structuredContent.attachments.find((a: any) => a.kind === 'voice_memo');
    assert.match(
      text(await call('get_attachment', { attachment_id: memo.attachment_id, mode: 'text' })),
      /No transcript/,
    );
    const link = await call('get_attachment', { attachment_id: img.attachment_id, mode: 'link' });
    const res = await fetch(link.structuredContent.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const links = await call('list_links', { query: 'cabin', format: 'json' });
    assert.equal(links.structuredContent.links[0].site, 'stays.example');
  });

  it('replays a send with the same key, and refuses the key for a different message', async () => {
    const byId = await call('read_conversation', { chat: 'p_sam_lee', limit: 2 });
    assert.match(text(byId), /Sam Lee · 1:1/);
    const a = await call('send_message', {
      to: 'p_sam_ortiz',
      text: 'found your charger!',
      idempotency_key: 'key-0001-aaaa',
    });
    assert.equal(a.structuredContent.disposition, 'delivered');
    const again = await call('send_message', {
      to: 'Sam Ortiz',
      text: 'found your charger!',
      idempotency_key: 'key-0001-aaaa',
    });
    assert.equal(again.structuredContent.message_id, a.structuredContent.message_id);
    const reused = await call('send_message', {
      to: 'Mom',
      text: 'different message',
      idempotency_key: 'key-0001-aaaa',
    });
    assert.equal(reused.isError, true);
    assert.match(text(reused), /idempotency_conflict/);
  });

  it('asks for confirmation before messaging a stranger', async () => {
    const stranger = await call('send_message', { to: '+15555550188', text: 'hi', idempotency_key: 'key-0002-bbbb' });
    assert.equal(stranger.isError, true);
    assert.match(text(stranger), /confirmation_required/);
    const confirmed = await call('send_message', {
      to: '+15555550188',
      text: 'who is this?',
      idempotency_key: 'key-0002-bbbb',
      user_confirmed: true,
    });
    assert.equal(confirmed.structuredContent.disposition, 'delivered');
  });

  it('reports a failed send as an error that is safe to retry', async () => {
    const fail = await call('send_message', {
      to: '+15555550000',
      text: 'test',
      idempotency_key: 'key-0003-cccc',
      user_confirmed: true,
    });
    assert.equal(fail.structuredContent.disposition, 'failed');
    assert.equal(fail.structuredContent.retry_safe, true);
    assert.equal(fail.isError, true);
  });

  it('refuses an unknown argument instead of sending', async () => {
    const unknownArg = await call('send_message', {
      to: 'Sam Ortiz',
      text: 'x',
      idempotency_key: 'key-unk-0001',
      recipient: 'Jo',
    });
    assert.equal(unknownArg.isError, true);
    assert.match(text(unknownArg), /unknown_argument/);
  });

  it('get_updates reports new messages since its cursor', async () => {
    const start = await call('get_updates', { cursor: 'now' });
    for (const n of [1, 2, 3])
      await call('send_message', { to: 'Sam Ortiz', text: `update ${n}`, idempotency_key: `key-upd-000${n}` });
    const upd = await call('get_updates', { cursor: start.structuredContent.next_cursor });
    assert.equal(upd.structuredContent.events.filter((e: any) => e.type === 'new').length, 3);
  });

  it('edits, reacts to, replies to and unsends a sent message', async () => {
    const id = (
      await call('send_message', { to: 'Sam Ortiz', text: 'found your charger!', idempotency_key: 'key-pa-0001' })
    ).structuredContent.message_id;
    assert.match(text(await call('edit_message', { message_id: id, text: 'found your charger!! 🔌' })), /\(edited\)/);
    assert.match(text(await call('react', { message_id: id, reaction: 'love' })), /❤️ You/);
    const rich = await call('send_message', {
      to: 'Sam Ortiz',
      text: 'see you there',
      reply_to: id,
      effect: 'confetti',
      idempotency_key: 'key-rich-0001',
    });
    assert.match(text(rich), /↳ reply to/);
    assert.match(text(rich), /sent with confetti/);
    assert.match(text(await call('unsend_message', { message_id: id })), /\[unsent\]/);
  });

  it('drafts, aliases, labels and reminders round-trip', async () => {
    const d = await call('create_draft', { to: 'Priya', text: "yes I'll be at the 10am" });
    assert.equal(d.structuredContent.status, 'draft');
    const sent = await call('manage_drafts', { action: 'send_now', draft_id: d.structuredContent.draft_id });
    assert.match(text(sent), /DELIVERED/);
    const ack = await call('update_person', { person: 'Marcus', add_aliases: ['my landlord'] });
    assert.deepEqual(ack.structuredContent.aliases, ['my landlord']);
    assert.equal('last_interaction' in ack.structuredContent, false);
    const p = await call('get_person', { person: 'my landlord' });
    assert.equal(p.structuredContent.person_id, 'p_marcus');
    await call('label_conversation', { chat: 'Cabin Weekend', add: ['trip'] });
    const lc = await call('list_conversations', { label: 'trip', format: 'json' });
    assert.equal(lc.structuredContent.conversations.length, 1);
    const r = await call('set_reminder', { chat: 'Mom', remind_at: '2h', note: 'call back about Thanksgiving' });
    assert.ok(r.structuredContent.reminder_id);
    assert.equal(r.structuredContent.dismiss_when, 'i_reply'); // Mom is waiting on a reply
    assert.match(text(await call('set_reminder', { chat: 'Mom', remind_at: '30m' })), /ambiguous_unit/);
  });

  it('lists conversations needing a reply, stats, status and group management', async () => {
    const nr = await call('list_conversations', { needs_reply: true, format: 'json' });
    assert.ok(nr.structuredContent.conversations.some((c: any) => c.title === 'Sam Lee'));
    const st = await call('get_stats', { group_by: 'person' });
    assert.equal(st.structuredContent.rows[0].label, 'Linda Carter');
    const status = await call('get_status');
    assert.equal(status.structuredContent.mode, 'mock');
    const g = await call('manage_group', { action: 'rename', chat: 'Product Team', title: 'Northwind Product' });
    assert.equal(g.structuredContent.title, 'Northwind Product');
    const mr = await call('mark_read', { chat: 'Sam Lee' });
    assert.ok(mr.structuredContent.changed >= 1);
  });

  it('serves the ChatGPT search/fetch contract with citation URLs', async () => {
    const s = await call('search', { query: 'cabin' });
    assert.ok(s.structuredContent.results.length > 0);
    const first = s.structuredContent.results[0];
    assert.ok(first.url.startsWith(base));
    const f = await call('fetch', { id: first.id });
    assert.ok(f.structuredContent.text.length > 50);
    const page = await fetch(first.url);
    assert.equal(page.status, 200);
    assert.equal((await fetch(first.url.replace(/sig=[^&]+/, 'sig=forged'))).status, 403);
  });

  it('rejects bad times with a fix', async () => {
    const r = await call('search_messages', { query: 'pie', on: 'yesterday', after: '3d' });
    assert.equal(r.isError, true);
    assert.match(text(r), /can't be combined/);
    const bad = await call('read_conversation', { chat: 'Mom', after: 'next blue moon' });
    assert.match(text(bad), /invalid_time/);
  });
});
