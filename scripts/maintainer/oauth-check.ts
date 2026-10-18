// End-to-end OAuth + MCP check against a deployed gateway: discovery, registration, sign-in, token refresh, one
// get_status call. Signs in with the owner password and prints only pass/fail lines; reads no message data.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pkceS256, randomId } from '../../src/auth/crypto.js';
import { gatewayArgs } from './lib/gateway.js';

const { base, password } = gatewayArgs('scripts/maintainer/oauth-check.ts [gateway-url]');
const redirect = 'http://127.0.0.1:8976/callback';
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};

const unauth = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
});
const challenge = unauth.headers.get('www-authenticate') ?? '';
ok('401 with resource_metadata', unauth.status === 401 && challenge.includes('resource_metadata='), challenge);
const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
ok('protected resource metadata', prm.resource === `${base}/mcp`, prm.resource);
const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
ok(
  'authorization server metadata',
  as.issuer === prm.authorization_servers[0] && as.client_id_metadata_document_supported === true,
  as.issuer,
);

const reg = await (
  await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: 'oauth-check', token_endpoint_auth_method: 'none' }),
  })
).json();
ok('dynamic client registration', !!reg.client_id);
const verifier = randomId(32);
const authUrl = new URL(as.authorization_endpoint);
for (const [k, v] of Object.entries({
  response_type: 'code',
  client_id: reg.client_id,
  redirect_uri: redirect,
  code_challenge: pkceS256(verifier),
  code_challenge_method: 'S256',
  state: 's1',
  scope: prm.scopes_supported.join(' '),
  resource: prm.resource,
}))
  authUrl.searchParams.set(k, v);
const html = await (await fetch(authUrl)).text();
const req = html.match(/name="req" value="([^"]+)"/)?.[1] ?? '';
ok('consent page', !!req);
const form = new URLSearchParams({ req, password, action: 'allow' });
form.append('scope', 'messages.organize');
form.append('scope', 'messages.send');
const post = await fetch(as.authorization_endpoint, { method: 'POST', body: form, redirect: 'manual' });
const loc = new URL(post.headers.get('location') ?? 'http://x/');
ok(
  'login redirects with code + iss',
  post.status === 302 && !!loc.searchParams.get('code') && loc.searchParams.get('iss') === as.issuer,
  `${post.status} iss=${loc.searchParams.get('iss')}`,
);
const tok = await (
  await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: loc.searchParams.get('code') ?? '',
      redirect_uri: redirect,
      client_id: reg.client_id,
      code_verifier: verifier,
      resource: prm.resource,
    }),
  })
).json();
ok('token exchange', !!tok.access_token && !!tok.refresh_token, tok.scope ?? tok.error);
const ref = await (
  await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: reg.client_id,
    }),
  })
).json();
ok('refresh', !!ref.access_token);

const client = new Client({ name: 'oauth-check', version: '1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(prm.resource), {
    requestInit: { headers: { Authorization: `Bearer ${ref.access_token}` } },
  }),
);
const { tools } = await client.listTools();
ok('MCP tools/list with token', tools.length > 0, `${tools.length} tools`);
const status: any = await client.callTool({
  name: 'get_status',
  arguments: { intent: 'owner checking the gateway connection works' },
});
ok('MCP tool call', status.structuredContent?.mode !== undefined, `mode=${status.structuredContent?.mode}`);
await client.close();
