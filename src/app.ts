import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { type CimdFetcher, defaultCimdFetcher } from './auth/clients.js';
import { Signer } from './auth/crypto.js';
import { type AuthDeps, checkBearer, registerOAuthRoutes } from './auth/oauth.js';
import { type Backend, LocalBackend, RelayBackend } from './backend.js';
import type { Config } from './config.js';
import { checkViewLink, verifyFileLink } from './links.js';
import type { RelayHub } from './relay/hub.js';
import { MAX_MCP_BODY_BYTES } from './relay/protocol.js';
import type { MessageStore } from './store/ports.js';

const MCP_ERROR = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });
/** Citation pages are private transcripts: never cached, never indexed. */
const VIEW_HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
/** OAuth form and JSON bodies are a few KB; anything near this is not a real client. */
const MAX_OAUTH_BODY_BYTES = 64 * 1024;

/** Types /files may display in the browser. Everything else, HTML, SVG and PDF included, downloads instead. */
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp|heic|heif)|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain)$/;

/**
 * Attachment bytes come from whoever sent the message, and /files shares an origin with /authorize, so a texted .html,
 * .svg or form-filled PDF must never render here as a page: it could pose as the sign-in form. Known media displays
 * inline in a sandbox with no scripts, forms or plugins; everything else is an attachment.
 */
function fileResponse(c: Context, data: Uint8Array<ArrayBuffer> | string, mime: string | undefined, name: string) {
  const type = (mime ?? '').split(';')[0].trim().toLowerCase();
  const inline = INLINE_TYPES.test(type);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/gu, '_') || 'file';
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return c.body(typeof data === 'string' ? new TextEncoder().encode(data) : data, 200, {
    'Content-Type': !inline ? 'application/octet-stream' : type === 'text/plain' ? 'text/plain; charset=utf-8' : type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${utf8}`,
    'X-Content-Type-Options': 'nosniff',
    // img/media 'self' lets the browser's own viewer page show the file; scripts stay blocked by default-src and sandbox.
    'Content-Security-Policy':
      "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
  });
}

/**
 * mock mode: the tools run here against `store`.
 * relay mode: the tools run on the Mac; `hub` forwards each authenticated call over the bridge WebSocket.
 */
export function createApp(cfg: Config, deps: { store?: MessageStore; hub?: RelayHub; fetchCimd?: CimdFetcher }) {
  if (cfg.production && !cfg.publicUrl) throw new Error('PUBLIC_URL is required unless DEV=1.');
  const app = new Hono();
  const sendLog: number[] = [];
  const signer = new Signer(cfg.auth.signingSecret);
  let backend: Backend;
  if (deps.hub) backend = new RelayBackend(deps.hub);
  else if (deps.store) backend = new LocalBackend(deps.store, cfg.tools, sendLog);
  else throw new Error('createApp needs a store (mock mode) or a relay hub (relay mode).');

  const origin = (c: Context) => {
    const url = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0] ?? url.protocol.replace(':', '');
    return `${proto}://${c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host}`;
  };
  let warnedOrigin = false;
  /** PUBLIC_URL, never request headers, except with DEV=1 and no PUBLIC_URL (a local server), which warns once. */
  const issuer = (c: Context) => {
    if (cfg.publicUrl) return cfg.publicUrl;
    if (!warnedOrigin) {
      warnedOrigin = true;
      console.warn('DEV: PUBLIC_URL not set, so the OAuth issuer is taken from request headers.');
    }
    return origin(c);
  };
  const authDeps: AuthDeps = { cfg, signer, fetchCimd: deps.fetchCimd ?? defaultCimdFetcher, issuer };

  const apiCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Authorization',
      'Content-Type',
      'Accept',
      'mcp-protocol-version',
      'mcp-session-id',
      'last-event-id',
    ],
    exposeHeaders: ['WWW-Authenticate', 'mcp-session-id', 'mcp-protocol-version'],
  });
  // Nothing here is meant to be framed. Cross-origin resource and opener policies stay off: chat clients may embed
  // /files images, and OAuth popups need window.opener after the redirect back.
  app.use(
    '*',
    secureHeaders({ xFrameOptions: 'DENY', crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false }),
  );
  for (const path of ['/mcp', '/.well-known/*', '/token', '/register', '/revoke']) app.use(path, apiCors);
  const oauthLimit = bodyLimit({
    maxSize: MAX_OAUTH_BODY_BYTES,
    onError: (c) => c.json({ error: 'invalid_request', error_description: 'Request body too large.' }, 413),
  });
  for (const path of ['/authorize', '/token', '/register', '/revoke']) app.use(path, oauthLimit);

  app.get('/', (c) => c.text('ok'));
  // Liveness only: anyone can call it, so it must not show when the Mac is online.
  app.get('/healthz', (c) => c.json({ ok: true }));

  const authState = registerOAuthRoutes(app, authDeps);

  // The limit comes first (a Content-Length check, before any auth work) so an oversized call never reaches the
  // bridge, whose socket would drop every other call in flight along with it.
  const mcpLimit = bodyLimit({
    maxSize: MAX_MCP_BODY_BYTES,
    onError: (c) => c.json(MCP_ERROR(-32600, 'Request body too large.'), 413),
  });
  app.post('/mcp', mcpLimit, async (c) => {
    const grant = await checkBearer(c, authDeps);
    if (grant instanceof Response) return grant;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(MCP_ERROR(-32700, 'Parse error'), 400);
    }
    const r = await backend.mcp(body, grant, issuer(c));
    if (r.kind === 'accepted') return c.body(null, 202);
    if (r.kind === 'json') return c.json(r.json, r.status);
    return new Response(r.body || null, { status: r.status, headers: r.headers });
  });
  app.on(['GET', 'DELETE'], '/mcp', (c) => c.json(MCP_ERROR(-32000, 'Method not allowed.'), 405, { Allow: 'POST' }));

  // Short-lived signed download links from get_attachment(mode=link). Signed on the Mac, verified here.
  app.get('/files/:id', async (c) => {
    const id = c.req.param('id');
    if (!verifyFileLink(cfg.tools.linkSecret, id, c.req.query('exp'), c.req.query('sig'), Date.now()))
      return c.text('Link expired or invalid.', 403);
    const r = await backend.file(id, issuer(c));
    return r.kind === 'file'
      ? fileResponse(c, r.data, r.mime, r.name)
      : c.text(r.text, r.status as ContentfulStatusCode);
  });

  // Signed citation pages for ChatGPT search/fetch results: 30-day links showing what fetch showed, nothing newer.
  app.get('/view/:kind/:id', async (c) => {
    const { kind, id } = c.req.param();
    const until = checkViewLink(
      cfg.tools.linkSecret,
      kind,
      id,
      { sig: c.req.query('sig'), exp: c.req.query('exp'), u: c.req.query('u') },
      Date.now(),
    );
    if (until === null) return c.text('Link expired or invalid.', 403, VIEW_HEADERS);
    const r = await backend.view(kind, id, until, issuer(c));
    return c.text(r.text, r.status as ContentfulStatusCode, VIEW_HEADERS);
  });

  // sendLog: the rate-limit log the tools use in mock mode, for the gateway entry point to share with the draft scheduler.
  return { app, authState, sendLog };
}
