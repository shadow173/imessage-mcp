// Helpers for the scripts that talk to a deployed gateway. The gateway URL and password always come from the command
// line or the environment; there is no default deployment.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pkceS256, randomId } from '../../../src/auth/crypto.js';

/**
 * The gateway URL (the first argument when it starts with http, else IMESSAGE_MCP_URL), the password
 * (IMESSAGE_MCP_PASSWORD) and the remaining arguments. Prints the usage line and exits 64 when either is missing.
 */
export function gatewayArgs(usage: string): { base: string; password: string; args: string[] } {
  const args = process.argv.slice(2);
  const fromArg = /^https?:\/\//.test(args[0] ?? '') ? args.shift() : undefined;
  const base = (fromArg ?? process.env.IMESSAGE_MCP_URL ?? '').replace(/\/+$/, '');
  const password = process.env.IMESSAGE_MCP_PASSWORD ?? '';
  if (!base || !password) {
    console.error(`Usage: IMESSAGE_MCP_PASSWORD=... npx tsx ${usage}`);
    console.error('The gateway URL comes from the first argument or IMESSAGE_MCP_URL.');
    process.exit(64);
  }
  return { base, password, args };
}

/** Signs in with the owner password (OAuth + PKCE) and returns a connected MCP client. */

export async function connectWithPassword(
  base: string,
  password: string,
  scopes = ['messages.read', 'messages.organize', 'messages.send'],
): Promise<Client> {
  const redirect = 'http://127.0.0.1:8976/callback';
  const reg = await (
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirect], client_name: 'owner-script' }),
    })
  ).json();
  const verifier = randomId(32);
  const u = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: redirect,
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    scope: scopes.join(' '),
    resource: `${base}/mcp`,
  }))
    u.searchParams.set(k, v);
  const req = (await (await fetch(u)).text()).match(/name="req" value="([^"]+)"/)?.[1];
  if (!req) throw new Error('no consent page');
  const form = new URLSearchParams({ req, password, action: 'allow' });
  for (const s of scopes) if (s !== 'messages.read') form.append('scope', s);
  const loc = new URL(
    (await fetch(`${base}/authorize`, { method: 'POST', body: form, redirect: 'manual' })).headers.get('location') ??
      'http://x/',
  );
  const code = loc.searchParams.get('code');
  if (!code) throw new Error(`login failed: ${loc.searchParams.get('error') ?? 'wrong password?'}`);
  const tok = await (
    await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        client_id: reg.client_id,
        code_verifier: verifier,
        resource: `${base}/mcp`,
      }),
    })
  ).json();
  const client = new Client({ name: 'owner-script', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
    }),
  );
  return client;
}
