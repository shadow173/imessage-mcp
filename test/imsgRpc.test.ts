import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ImsgError, ImsgRpc } from '../src/live/imsgRpc.js';

// The bridge keeps one imsg child for its whole life. Whatever that child does (split replies, errors, hangs, exits
// mid-call or before reading), each call must settle with an honest disposition and the bridge must not crash.
let dir: string;
let bin: string;
const live: ImsgRpc[] = [];
const rpc = (env: Record<string, string> = {}) => {
  const r = new ImsgRpc(bin, { env });
  live.push(r);
  return r;
};
const rejectsWith = (p: Promise<unknown>, want: Partial<ImsgError>) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ImsgError, String(e));
    for (const [k, v] of Object.entries(want)) assert.deepEqual(e[k as keyof ImsgError], v, k);
    return true;
  });

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'imsg-rpc-'));
  bin = join(dir, 'imsg');
  // Written at test time with this node as the interpreter, so it needs no exec bit in git and no node on PATH.
  writeFileSync(bin, `#!${process.execPath}\n${readFileSync(new URL('./fixtures/fake-imsg.mjs', import.meta.url))}`);
  chmodSync(bin, 0o755);
});
after(() => {
  for (const r of live) r.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('ImsgRpc against a fake imsg', () => {
  it('matches replies to calls, even out of order, split across writes, or after noise', async () => {
    const r = rpc();
    const [slow, fast, split, noisy] = await Promise.all([
      r.call('late', { ms: 80 }, 5000),
      r.call('echo', { n: 1 }, 5000),
      r.call('split', {}, 5000),
      r.call('noisy', {}, 5000),
    ]);
    assert.deepEqual(
      [slow, fast, split, noisy],
      [{ late: true }, { n: 1 }, { text: 'arrived in pieces ✓' }, { ok: true }],
    );
  });

  it("passes the server's error code, disposition and retry_safe through", async () => {
    await rejectsWith(rpc().call('fail', {}, 5000), {
      code: -32010,
      message: 'chat not found',
      disposition: 'not_delivered',
      retrySafe: true,
    });
  });

  it('times out a call as still_in_flight, and later calls still work', async () => {
    const r = rpc();
    await rejectsWith(r.call('hang', {}, 100), { code: -32001, disposition: 'still_in_flight', retrySafe: false });
    assert.deepEqual(await r.call('echo', { after: 'timeout' }, 5000), { after: 'timeout' });
  });

  it('fails every waiting call as may_have_completed when imsg exits mid-call, then starts a new one', async () => {
    const r = rpc();
    const waiting = r.call('hang', {}, 5000);
    const dying = r.call('die', {}, 5000);
    await rejectsWith(dying, { message: 'imsg rpc exited', disposition: 'may_have_completed', retrySafe: false });
    await rejectsWith(waiting, { disposition: 'may_have_completed' });
    assert.deepEqual(await r.call('echo', { again: true }, 5000), { again: true });
  });

  it('survives an imsg that exits before reading its input (EPIPE), and says so', async () => {
    const r = rpc({ FAKE_IMSG_MODE: 'exit-at-start' });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(r.call('echo', {}, 2000), (e: unknown) => {
        assert.ok(e instanceof ImsgError, String(e));
        assert.ok(e.disposition === 'may_have_completed' || e.disposition === 'not_started', e.disposition);
        return true;
      });
      await new Promise((res) => setTimeout(res, 20)); // let a late EPIPE surface, if one would crash us
    }
  });

  it('reports a missing binary as not started and safe to retry, every time', async () => {
    const r = new ImsgRpc(join(dir, 'no-such-imsg'));
    for (let i = 0; i < 2; i++)
      await rejectsWith(r.call('echo', {}, 2000), {
        message: `imsg not found at ${join(dir, 'no-such-imsg')}`,
        disposition: 'not_started',
        retrySafe: true,
      });
    const s = await r.status();
    assert.equal(s.bridgeReady, false);
    assert.match(s.reason!, /imsg not found/);
  });

  it('status() reports a helper that is not loaded', async () => {
    assert.deepEqual(await rpc().status(), { bridgeReady: false, reason: 'helper not loaded\nmore', methods: [] });
  });

  it("gives imsg a minimal environment: the bridge's secrets stay behind, IMSG_* settings pass", async () => {
    const saved = { BRIDGE_SECRET: process.env.BRIDGE_SECRET, LINK_SECRET: process.env.LINK_SECRET };
    process.env.BRIDGE_SECRET = 'bridge-secret-must-not-leak';
    process.env.LINK_SECRET = 'link-secret-must-not-leak';
    try {
      const { keys } = await rpc({ IMSG_DB: '/tmp/x' }).call<{ keys: string[] }>('env', {}, 5000);
      assert.ok(keys.includes('IMSG_DB'));
      assert.deepEqual(
        keys.filter(
          (k) =>
            ![
              'PATH',
              'HOME',
              'USER',
              'LOGNAME',
              'LANG',
              'LC_ALL',
              'LC_CTYPE',
              'TMPDIR',
              'DEVELOPER_DIR',
              'IMSG_DB',
              '__CF_USER_TEXT_ENCODING',
            ].includes(k),
        ),
        [],
      );
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });
});
