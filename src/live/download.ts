// Attachment downloads for send_message url attachments: public https only, checked on every DNS answer and
// redirect hop, so a link can't reach into the LAN (no SSRF).

import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';
import type { LookupFunction } from 'node:net';
import { ToolError } from '../lib/errors.js';
import { checkPublicHttpsUrl, isBlockedAddress, type UrlProblem, urlHost } from '../lib/net.js';

/** The largest file the bridge downloads or stages for sending. */
export const MAX_STAGE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export class DownloadError extends Error {
  constructor(
    readonly kind: 'blocked' | 'too_large' | 'http' | 'timeout' | 'redirects',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type Downloader = (url: string, capBytes: number) => Promise<{ data: Buffer; contentType?: string }>;

function checkTarget(u: URL) {
  const problem = checkPublicHttpsUrl(u);
  if (!problem) return;
  const reason: Record<UrlProblem, string> = {
    not_https: 'only https links can be attached',
    credentials: 'the link carries a user name or password',
    private_host: `${urlHost(u)} is a private or local address`,
  };
  throw new DownloadError('blocked', reason[problem]);
}

/** Resolves every address of a host name, like dns.lookup with all: true. */
export type ResolveAll = (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;

const resolveAll: ResolveAll = (hostname, options) => dnsLookup(hostname, options);

/** The network calls downloadPublic makes. Tests replace them; the defaults are node:dns and node:https. */
export interface DownloadNet {
  lookup?: ResolveAll;
  get?: typeof httpsGet;
}

/**
 * Resolves every address and refuses if any is private, then connects to the checked address (no DNS rebinding window).
 */
const guardedLookup =
  (resolver: ResolveAll): LookupFunction =>
  (hostname, options, cb) => {
    resolver(hostname, { all: true, family: options?.family ?? 0 }).then(
      (addrs) => {
        if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address)))
          return cb(new DownloadError('blocked', `${hostname} resolves to a private or local address`), '');
        if (options?.all) cb(null, addrs);
        else cb(null, addrs[0].address, addrs[0].family);
      },
      (err) => cb(err, ''),
    );
  };

function fetchOnce(
  u: URL,
  deadline: number,
  cap: number,
  get: typeof httpsGet,
  lookup: LookupFunction,
): Promise<{ status: number; location?: string; contentType?: string; data: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };
    const fail = (e: Error) => {
      finish(() => reject(e));
      req.destroy();
    };
    const req = get(u, { lookup, headers: { 'user-agent': 'imessage-mcp-bridge', accept: '*/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        finish(() => resolve({ status, location: res.headers.location, data: Buffer.alloc(0) }));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        finish(() => resolve({ status, data: Buffer.alloc(0) }));
        return;
      }
      if (Number(res.headers['content-length'] ?? 0) > cap) return fail(new DownloadError('too_large', 'over 100 MB'));
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => {
        n += c.length;
        if (n > cap) fail(new DownloadError('too_large', 'over 100 MB'));
        else chunks.push(c);
      });
      res.on('end', () =>
        finish(() => resolve({ status, contentType: res.headers['content-type'], data: Buffer.concat(chunks) })),
      );
      res.on('error', fail);
    });
    const timer = setTimeout(
      () => fail(new DownloadError('timeout', `timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)} s`)),
      Math.max(0, deadline - Date.now()),
    );
    req.on('error', fail);
  });
}

/**
 * Downloads a public https file: blocked ranges refused on every hop, at most 3 redirects, a size cap and a 30 s
 * overall timeout.
 */
export async function downloadPublic(
  url: string,
  cap = MAX_STAGE_BYTES,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  net: DownloadNet = {},
): Promise<{ data: Buffer; contentType?: string }> {
  const deadline = Date.now() + timeoutMs;
  const get = net.get ?? httpsGet;
  const lookup = guardedLookup(net.lookup ?? resolveAll);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DownloadError('blocked', 'that is not a valid URL');
  }
  for (let hop = 0; ; hop++) {
    checkTarget(u);
    const r = await fetchOnce(u, deadline, cap, get, lookup);
    if (r.location) {
      if (hop >= 3) throw new DownloadError('redirects', 'the link redirected more than 3 times');
      try {
        u = new URL(r.location, u);
      } catch {
        throw new DownloadError('redirects', 'the link redirected to an invalid URL');
      }
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new DownloadError('http', `HTTP ${r.status}`, r.status);
    return { data: r.data, contentType: r.contentType };
  }
}

export const DOWNLOAD_FIX =
  'Nothing was sent. Check the link is public and points straight to the file, or pass attachment_id/base64.';

/** A download failure as the tool error the model sees. Nothing has been sent when it is thrown. */
export function downloadError(filename: string, e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  const d = e instanceof DownloadError ? e : undefined;
  if (d?.kind === 'blocked')
    return new ToolError(
      'attachment_url_blocked',
      `${filename}: ${d.message}, so it can't be attached. Nothing was sent.`,
      'Pass attachment_id for a file already in Messages, or base64.',
    );
  if (d?.status === 413)
    return new ToolError(
      'attachment_too_large',
      `${filename} is too large to download through the gateway. Nothing was sent.`,
      'Forward it with attachment_id instead of url.',
    );
  if (d?.kind === 'too_large')
    return new ToolError(
      'attachment_too_large',
      `${filename} is over 100 MB. Nothing was sent.`,
      'Send a smaller file, or put a link to it in the text.',
    );
  const x = e as { code?: unknown; cause?: { code?: unknown }; message?: string };
  const reason = d ? d.message : String(x.code ?? x.cause?.code ?? x.message ?? 'unknown error').slice(0, 120);
  return new ToolError('attachment_download_failed', `Couldn't download ${filename}: ${reason}.`, DOWNLOAD_FIX);
}
