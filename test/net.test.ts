import assert from 'node:assert/strict';
import type { LookupAllOptions } from 'node:dns';
import { EventEmitter } from 'node:events';
import type { get as httpsGet } from 'node:https';
import type { LookupFunction } from 'node:net';
import { describe, it } from 'node:test';
import { checkPublicHttpsUrl, isBlockedAddress } from '../src/lib/net.js';
import { DownloadError, downloadPublic, type ResolveAll } from '../src/live/download.js';

// Attachment URLs come from the agent, which may have copied them from a message. Every fetch the bridge makes for one
// must stay on the public internet: no loopback, LAN, link-local or cloud metadata address, however it is spelled.

describe('isBlockedAddress', () => {
  const blocked = [
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'private'],
    ['100.64.0.1', 'shared (CGNAT)'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local (cloud metadata)'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private, top of the range'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::127.0.0.1', 'IPv4-compatible'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:0:7f00:1', 'IPv4-translated loopback'],
    ['64:ff9b::7f00:1', 'NAT64'],
    ['100::1', 'discard-only'],
    ['2001::1', 'Teredo'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
    ['2002:7f00:1::1', '6to4 wrapping 127.0.0.1'],
    ['2002:c0a8:101::1', '6to4 wrapping 192.168.1.1'],
    ['fc00::1', 'unique local'],
    ['fd00::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['example.com', 'not an IP address'],
    ['', 'empty'],
  ];
  const allowed = [
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['100.128.0.1', 'just past 100.64.0.0/10'],
    ['172.32.0.1', 'just past 172.16.0.0/12'],
    ['198.20.0.1', 'just past 198.18.0.0/15'],
    ['::ffff:8.8.8.8', 'IPv4-mapped public'],
    ['100:0:0:1::1', 'just past 100::/64'],
    ['2001:4860:4860::8888', 'just past 2001::/32'],
    ['2003::1', 'just past 2002::/16'],
    ['2606:4700::1111', 'public'],
  ];
  for (const [ip, why] of blocked) it(`blocks ${ip || '""'} (${why})`, () => assert.equal(isBlockedAddress(ip), true));
  for (const [ip, why] of allowed) it(`allows ${ip} (${why})`, () => assert.equal(isBlockedAddress(ip), false));
});

describe('checkPublicHttpsUrl', () => {
  const cases: [string, ReturnType<typeof checkPublicHttpsUrl>][] = [
    ['https://example.com/a.png', null],
    ['https://8.8.8.8/a.png', null],
    ['https://[2606:4700::1111]/a.png', null],
    ['http://example.com/a.png', 'not_https'],
    ['ftp://example.com/a', 'not_https'],
    ['https://user:pw@example.com/a', 'credentials'],
    ['https://127.0.0.1/a', 'private_host'],
    ['https://2130706433/a', 'private_host'],
    ['https://0x7f.1/a', 'private_host'],
    ['https://[::1]/a', 'private_host'],
    ['https://[::ffff:192.168.1.1]/a', 'private_host'],
    ['https://[2002:7f00:1::1]/a', 'private_host'],
    ['https://[2001::1]/a', 'private_host'],
    ['https://localhost/a', 'private_host'],
    ['https://LOCALHOST./a', 'private_host'],
    ['https://intranet/a', 'private_host'],
    ['https://printer.local/a', 'private_host'],
    ['https://svc.internal/a', 'private_host'],
    ['https://nas.lan/a', 'private_host'],
    ['https://router.home.arpa/a', 'private_host'],
  ];
  for (const [url, want] of cases)
    it(`${url} → ${want ?? 'ok'}`, () => assert.equal(checkPublicHttpsUrl(new URL(url)), want));
});

/** A resolver that answers from a table and records each question. */
function resolver(answers: Record<string, string[]>) {
  const asked: string[] = [];
  const lookup: ResolveAll = async (hostname: string, _options: LookupAllOptions) => {
    asked.push(hostname);
    const addrs = answers[hostname];
    if (!addrs) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { lookup, asked };
}

type Reply = { status: number; location?: string; body?: string };

/** Stands in for https.get: resolves the host through the lookup it is handed, then answers from a table. */
function fakeGet(replies: Record<string, Reply>) {
  const fetched: string[] = [];
  const get = (u: URL, opts: { lookup: LookupFunction }, cb: (res: EventEmitter) => void) => {
    const req = Object.assign(new EventEmitter(), { destroy() {} });
    opts.lookup(u.hostname, {}, (err) => {
      if (err) return req.emit('error', err);
      fetched.push(u.href);
      const r = replies[u.href] ?? { status: 404 };
      const res = Object.assign(new EventEmitter(), {
        statusCode: r.status,
        headers: r.location ? { location: r.location } : { 'content-type': 'image/png' },
        resume() {},
      });
      cb(res);
      if (r.body) res.emit('data', Buffer.from(r.body));
      res.emit('end');
    });
    return req;
  };
  return { get: get as unknown as typeof httpsGet, fetched };
}

const blockedWith = (message: string) => (e: unknown) =>
  e instanceof DownloadError && e.kind === 'blocked' && e.message === message;

describe('downloadPublic', () => {
  it('refuses private, local and non-https targets before connecting', async () => {
    for (const url of [
      'http://example.com/a.png',
      'https://127.0.0.1/a',
      'https://[::1]/a',
      'https://[2002:7f00:1::1]/a',
      'https://10.1.2.3/a',
      'https://user:pw@example.com/a',
      'https://printer.local/a',
      'https://intranet/a',
      'https://localhost/a',
    ]) {
      await assert.rejects(
        downloadPublic(url, 1000, 2000),
        (e: unknown) => e instanceof DownloadError && e.kind === 'blocked',
        url,
      );
    }
  });

  it('says why a target was refused', async () => {
    await assert.rejects(
      downloadPublic('http://example.com/a', 1000, 2000),
      blockedWith('only https links can be attached'),
    );
    await assert.rejects(
      downloadPublic('https://user:pw@example.com/a', 1000, 2000),
      blockedWith('the link carries a user name or password'),
    );
    await assert.rejects(
      downloadPublic('https://[::1]/a', 1000, 2000),
      blockedWith('::1 is a private or local address'),
    );
  });

  it('refuses a public name that resolves to a private address, through the real https stack', async () => {
    const dns = resolver({ 'cdn.example.com': ['10.0.0.1'] });
    await assert.rejects(
      downloadPublic('https://cdn.example.com/a.png', 1000, 2000, { lookup: dns.lookup }),
      blockedWith('cdn.example.com resolves to a private or local address'),
    );
    assert.deepEqual(dns.asked, ['cdn.example.com']);
  });

  it('refuses when any one of the answers is private', async () => {
    const dns = resolver({ 'cdn.example.com': ['93.184.216.34', '::ffff:0:7f00:1'] });
    const net = fakeGet({ 'https://cdn.example.com/a.png': { status: 200, body: 'png' } });
    await assert.rejects(
      downloadPublic('https://cdn.example.com/a.png', 1000, 2000, { lookup: dns.lookup, get: net.get }),
      blockedWith('cdn.example.com resolves to a private or local address'),
    );
    assert.deepEqual(net.fetched, []);
  });

  it('downloads from a public address', async () => {
    const dns = resolver({ 'cdn.example.com': ['93.184.216.34'] });
    const net = fakeGet({ 'https://cdn.example.com/a.png': { status: 200, body: 'png bytes' } });
    const r = await downloadPublic('https://cdn.example.com/a.png', 1000, 2000, { lookup: dns.lookup, get: net.get });
    assert.equal(r.data.toString(), 'png bytes');
    assert.equal(r.contentType, 'image/png');
  });

  it('checks every redirect hop: a private literal, a name that resolves privately, and plain http', async () => {
    const dns = resolver({ 'cdn.example.com': ['93.184.216.34'], 'files.example.net': ['192.168.1.10'] });
    const net = fakeGet({
      'https://cdn.example.com/literal': { status: 302, location: 'https://127.0.0.1/admin' },
      'https://cdn.example.com/rebind': { status: 301, location: 'https://files.example.net/x' },
      'https://cdn.example.com/http': { status: 307, location: 'http://cdn.example.com/a.png' },
    });
    const get = (path: string) =>
      downloadPublic(`https://cdn.example.com/${path}`, 1000, 2000, { lookup: dns.lookup, get: net.get });
    await assert.rejects(get('literal'), blockedWith('127.0.0.1 is a private or local address'));
    await assert.rejects(get('rebind'), blockedWith('files.example.net resolves to a private or local address'));
    await assert.rejects(get('http'), blockedWith('only https links can be attached'));
    assert.deepEqual(net.fetched, [
      'https://cdn.example.com/literal',
      'https://cdn.example.com/rebind',
      'https://cdn.example.com/http',
    ]);
  });

  it('follows at most 3 redirects', async () => {
    const dns = resolver({ 'cdn.example.com': ['93.184.216.34'] });
    const hops = Object.fromEntries(
      [0, 1, 2, 3].map((i) => [`https://cdn.example.com/${i}`, { status: 302, location: `/${i + 1}` }]),
    );
    const net = fakeGet({ ...hops, 'https://cdn.example.com/3': { status: 200, body: 'ok' } });
    const ok = await downloadPublic('https://cdn.example.com/0', 1000, 2000, { lookup: dns.lookup, get: net.get });
    assert.equal(ok.data.toString(), 'ok');
    const loop = fakeGet(hops);
    await assert.rejects(
      downloadPublic('https://cdn.example.com/0', 1000, 2000, { lookup: dns.lookup, get: loop.get }),
      (e: unknown) => e instanceof DownloadError && e.kind === 'redirects',
    );
  });
});
