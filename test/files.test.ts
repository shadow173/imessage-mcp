import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { signFile } from '../src/links.js';
import type { RelayHub } from '../src/relay/hub.js';
import type { BridgeToGateway, GatewayToBridge } from '../src/relay/protocol.js';
import { devGatewayConfig } from './helpers/gateway.js';
import { liveClockMockStore } from './helpers/mock.js';

// /files shares an origin with /authorize, and the bytes come from whoever texted them. A texted .html or .svg shown
// inline here could draw a fake sign-in page on the real host, so only known media is inline, always sandboxed.
const LINK_SECRET = 'files-test-link-secret-0123456789abcdef';
const PASSWORD = 'files test password';
const CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

const link = (id: string, exp = Math.floor(Date.now() / 1000) + 600) =>
  `http://localhost/files/${id}?exp=${exp}&sig=${signFile(LINK_SECRET, id, exp)}`;

/** A relay gateway whose bridge answers each file request from `files` (attachment id -> reply). */
async function relayApp(files: Record<string, Partial<Extract<BridgeToGateway, { type: 'file_result' }>>>) {
  const cfg = devGatewayConfig(PASSWORD, { LINK_SECRET, MODE: 'relay', BRIDGE_SECRET: 'b'.repeat(40) });
  const hub = {
    connected: () => true,
    request: async (frame: Omit<Extract<GatewayToBridge, { type: 'file' }>, 'id'>) => ({
      type: 'file_result',
      id: 1,
      status: 200,
      ...files[frame.attachmentId],
    }),
  } as unknown as RelayHub;
  return createApp(cfg, { hub }).app;
}
const b64 = (s: string) => Buffer.from(s).toString('base64');

function assertLockedDown(res: Response) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), CSP);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
}

describe('/files', () => {
  it('reads exp only as plain digits, so a link verifies in exactly one form', async () => {
    const app = await relayApp({ a1: { contentType: 'image/jpeg', name: 'IMG_1.JPG', base64: b64('jpeg bytes') } });
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = signFile(LINK_SECRET, 'a1', exp);
    for (const e of [`0x${exp.toString(16)}`, `${exp}.0`, `${exp / 10}e1`, ` ${exp}`, `+${exp}`])
      assert.equal(
        (await app.request(`http://localhost/files/a1?exp=${encodeURIComponent(e)}&sig=${sig}`)).status,
        403,
        e,
      );
    assert.equal((await app.request(`http://localhost/files/a1?exp=${exp}&sig=${sig}`)).status, 200);
  });

  it('serves known media inline, sandboxed and uncached', async () => {
    const app = await relayApp({
      a1: { contentType: 'image/jpeg', name: 'IMG_1.JPG', base64: b64('jpeg bytes') },
      a2: { contentType: 'video/quicktime', name: 'IMG_2.MOV', base64: b64('mov bytes') },
      a3: { contentType: 'text/plain', name: 'notes.txt', base64: b64('hello') },
    });
    const img = await app.request(link('a1'));
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal(img.headers.get('content-disposition'), `inline; filename="IMG_1.JPG"; filename*=UTF-8''IMG_1.JPG`);
    assert.equal(await img.text(), 'jpeg bytes');
    assertLockedDown(img);
    assert.equal((await app.request(link('a2'))).headers.get('content-type'), 'video/quicktime');
    const txt = await app.request(link('a3'));
    assert.equal(txt.headers.get('content-type'), 'text/plain; charset=utf-8');
    assertLockedDown(txt);
  });

  it('downloads HTML, SVG, PDF, scripts and unknown types as octet-stream attachments', async () => {
    const cases: [string, string | undefined, string][] = [
      ['h', 'text/html', 'login.html'],
      ['h2', 'TEXT/HTML; charset=utf-8', 'login.htm'],
      ['s', 'image/svg+xml', 'logo.svg'],
      ['p', 'application/pdf', 'form.pdf'],
      ['j', 'application/javascript', 'x.js'],
      ['x', 'application/xhtml+xml', 'page.xhtml'],
      ['n', undefined, 'mystery'],
    ];
    const app = await relayApp(
      Object.fromEntries(
        cases.map(([id, contentType, name]) => [id, { contentType, name, base64: b64('<script>alert(1)</script>') }]),
      ),
    );
    for (const [id, type, name] of cases) {
      const res = await app.request(link(id));
      assert.equal(res.status, 200, name);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream', `${type} -> octet-stream`);
      assert.match(res.headers.get('content-disposition')!, /^attachment; /, name);
      assertLockedDown(res);
    }
  });

  it('encodes non-ASCII file names instead of failing', async () => {
    const app = await relayApp({
      cjk: { contentType: 'image/png', name: '写真 2026.png', base64: b64('png') },
      emoji: { contentType: 'application/pdf', name: 'lease 🏠 "final".pdf', base64: b64('pdf') },
      odd: { contentType: 'image/png', name: "it's (1)*.png", base64: b64('png') },
    });
    const cjk = await app.request(link('cjk'));
    assert.equal(cjk.status, 200);
    assert.equal(
      cjk.headers.get('content-disposition'),
      `inline; filename="__ 2026.png"; filename*=UTF-8''%E5%86%99%E7%9C%9F%202026.png`,
    );
    const emoji = await app.request(link('emoji'));
    assert.equal(
      emoji.headers.get('content-disposition'),
      `attachment; filename="lease _ _final_.pdf"; filename*=UTF-8''lease%20%F0%9F%8F%A0%20%22final%22.pdf`,
    );
    assert.equal(
      (await app.request(link('odd'))).headers.get('content-disposition'),
      `inline; filename="it's (1)*.png"; filename*=UTF-8''it%27s%20%281%29%2A.png`,
    );
  });

  it('refuses expired, tampered and unsigned links before asking the Mac', async () => {
    let asked = 0;
    const cfg = devGatewayConfig(PASSWORD, { LINK_SECRET, MODE: 'relay', BRIDGE_SECRET: 'b'.repeat(40) });
    const hub = {
      connected: () => true,
      request: async () => {
        asked++;
        return { type: 'file_result', id: 1, status: 200, contentType: 'image/png', name: 'a.png', base64: b64('x') };
      },
    } as unknown as RelayHub;
    const { app } = createApp(cfg, { hub });
    const past = Math.floor(Date.now() / 1000) - 1;
    for (const url of [
      link('a1', past),
      link('a1').replace(/sig=[^&]+/, 'sig=forged'),
      link('a1').replace('/a1?', '/a2?'),
      'http://localhost/files/a1',
    ])
      assert.equal((await app.request(url)).status, 403, url);
    assert.equal(asked, 0);
  });

  it('mock mode serves through the same headers', async () => {
    const store = liveClockMockStore();
    const cfg = devGatewayConfig(PASSWORD, { LINK_SECRET });
    const { app } = createApp(cfg, { store });
    const photo = await app.request(link('a100'));
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assertLockedDown(photo);
    const pdf = await app.request(link('a103'));
    assert.equal(pdf.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(pdf.headers.get('content-disposition')!, /^inline; filename="lease-renewal-2027\.pdf"/);
    assertLockedDown(pdf);
  });
});
