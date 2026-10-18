// The bridge's relay side: answering gateway frames, and the connect / hello / reconnect loop, on a fake WebSocket.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type WebSocket from 'ws';
import { createFrameHandler, fitFrame } from '../src/bridge/frames.js';
import { connectGateway, type GatewayClientOptions } from '../src/bridge/gatewayClient.js';
import {
  type BridgeToGateway,
  CLOSE_REPLACED_BY_NEWER,
  type GatewayToBridge,
  MAX_FILE_BYTES,
  MAX_FRAME_BYTES,
} from '../src/relay/protocol.js';
import { captureConsole } from './helpers/console.js';
import { makeCtx } from './helpers/ctx.js';
import { newMockStore } from './helpers/mock.js';
import { waitFor } from './helpers/wait.js';

const mcpFrame = (body: unknown): GatewayToBridge => ({
  type: 'mcp',
  id: 9,
  body,
  grant: { scopes: ['messages.read'], clientId: 'c' },
  baseUrl: 'https://gw.example',
});
/** A frame limit small enough to test without building 24 MB strings. */
const LIMIT = 4096;
const huge = 'x'.repeat(LIMIT);

describe('bridge frames', () => {
  const store = newMockStore();
  const handle = createFrameHandler(store, (scopes, baseUrl, client) => ({
    ...makeCtx({}, { store }),
    scopes: new Set(scopes),
    baseUrl,
    client,
  }));

  it('answers MCP calls with the caller grant, and citation pages with 404 for unknown targets', async () => {
    const r = await handle(
      mcpFrame({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_status', arguments: { intent: 'bridge frame test of a status call' } },
      }),
    );
    assert.equal(r.type, 'mcp_result');
    assert.equal(r.type === 'mcp_result' && r.id, 9);
    assert.match(r.type === 'mcp_result' ? r.body : '', /"mode":"mock"/);
    const chat = store.chats()[0].chatId;
    const page = await handle({ type: 'view', id: 2, kind: 'chat', target: chat, baseUrl: '' });
    assert.deepEqual([page.type, 'status' in page && page.status], ['view_result', 200]);
    for (const kind of ['chat', 'msg'] as const)
      assert.deepEqual(await handle({ type: 'view', id: 3, kind, target: 'nope', baseUrl: '' }), {
        type: 'view_result',
        id: 3,
        status: 404,
        text: '',
      });
  });

  it('answers a file the store cannot serve with 413 when it is over the frame limit, else 404', async () => {
    const big = store.listAttachments({}, { limit: 500, offset: 0 }).items.find((a) => a.bytes > MAX_FILE_BYTES)!;
    assert.ok(big, 'the seed has an attachment over the limit');
    assert.deepEqual(await handle({ type: 'file', id: 4, attachmentId: big.attachmentId, baseUrl: '' }), {
      type: 'file_result',
      id: 4,
      status: 413,
    });
    assert.deepEqual(await handle({ type: 'file', id: 5, attachmentId: 'a0', baseUrl: '' }), {
      type: 'file_result',
      id: 5,
      status: 404,
    });
  });

  it('passes small replies through, and swaps an oversized one for 413 or a -32603 error per request id', async () => {
    const small: BridgeToGateway = { type: 'view_result', id: 1, status: 200, text: 'ok' };
    assert.equal(
      fitFrame({ type: 'view', id: 1, kind: 'msg', target: 'm1', baseUrl: '' }, small),
      JSON.stringify(small),
    );
    assert.equal(
      fitFrame(
        { type: 'view', id: 1, kind: 'msg', target: 'm1', baseUrl: '' },
        { ...small, text: 'x'.repeat(LIMIT * 2) },
      ).length > LIMIT,
      true,
      'the real limit is MAX_FRAME_BYTES',
    );
    const { lines } = await captureConsole(() => {
      const view = JSON.parse(
        fitFrame(
          { type: 'view', id: 2, kind: 'msg', target: 'm1', baseUrl: '' },
          { type: 'view_result', id: 2, status: 200, text: huge },
          LIMIT,
        ),
      );
      assert.deepEqual(view, { type: 'view_result', id: 2, status: 413, text: '' });
      const file = JSON.parse(
        fitFrame(
          { type: 'file', id: 3, attachmentId: 'a1', baseUrl: '' },
          { type: 'file_result', id: 3, status: 200, base64: huge },
          LIMIT,
        ),
      );
      assert.deepEqual(file, { type: 'file_result', id: 3, status: 413 });
      const bigMcp = (body: unknown) =>
        JSON.parse(
          fitFrame(mcpFrame(body), { type: 'mcp_result', id: 9, status: 200, headers: {}, body: huge }, LIMIT),
        ) as Extract<BridgeToGateway, { type: 'mcp_result' }>;
      const one = bigMcp({ jsonrpc: '2.0', id: 7, method: 'tools/call' });
      assert.deepEqual([one.id, one.status, one.headers], [9, 200, { 'content-type': 'application/json' }]);
      const err = JSON.parse(one.body);
      assert.deepEqual([err.id, err.error.code], [7, -32603]);
      assert.match(err.error.message, /Response too large for the gateway/);
      const batch = JSON.parse(
        bigMcp([{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', method: 'notifications/x' }, { id: 'b' }]).body,
      );
      assert.deepEqual(
        batch.map((e: { id: unknown }) => e.id),
        [1, 'b'],
      );
      assert.equal(JSON.parse(bigMcp({ jsonrpc: '2.0', method: 'notifications/x' }).body).id, null);
    });
    assert.equal(lines.filter((l) => /too large .* sent 413 instead/.test(l)).length, 5);
  });
});

/** Just enough of a ws client socket for the gateway client. */
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  constructor(
    readonly url: string,
    readonly opts: WebSocket.ClientOptions,
  ) {
    super();
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  send(s: string) {
    this.sent.push(s);
  }
  close(code = 1005) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code);
  }
  terminate() {
    this.close(1006);
  }
  frames() {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function harness(over: Partial<GatewayClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  let replaced = 0;
  const client = connectGateway({
    url: 'https://gw.example',
    secret: 's'.repeat(40),
    hello: async () => ({ type: 'hello', version: 't', mode: 'live', toolsList: { tools: [] }, me: 'Me' }),
    handle: async (f) => ({ type: 'view_result', id: f.id, status: 200, text: 'page' }),
    onReplaced: () => replaced++,
    createSocket: (url, opts) => {
      const s = new FakeSocket(url, opts);
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    timing: { firstRetryMs: 5, maxRetryMs: 20, jitterMs: 1, pingTimeoutMs: 60_000, watchdogMs: 10 },
    ...over,
  });
  return { client, sockets, replaced: () => replaced, last: () => sockets[sockets.length - 1] };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = <T>(fn: () => Promise<T>) => captureConsole(fn).then((r) => r.result);
const silenced = async <T>(fn: () => Promise<T>) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await quiet(fn);
  } finally {
    console.log = log;
  }
};

describe('gateway client', () => {
  it('dials /bridge over ws with the secret, says hello, and answers frames', async () => {
    await silenced(async () => {
      const h = harness();
      try {
        const s = h.last();
        assert.equal(s.url, 'wss://gw.example/bridge');
        assert.deepEqual(s.opts.headers, { Authorization: `Bearer ${'s'.repeat(40)}` });
        assert.equal(s.opts.maxPayload, MAX_FRAME_BYTES);
        s.open();
        await waitFor(() => s.sent.length === 1, 'the hello');
        assert.equal(s.frames()[0].type, 'hello');
        assert.ok(h.client.connected());
        s.emit('message', Buffer.from('not json'));
        s.emit('message', Buffer.from(JSON.stringify({ type: 'view', id: 5, kind: 'msg', target: 'm1', baseUrl: '' })));
        await waitFor(() => s.sent.length === 2, 'the reply');
        assert.deepEqual(s.frames()[1], { type: 'view_result', id: 5, status: 200, text: 'page' });
      } finally {
        h.client.close();
      }
    });
  });

  it('answers a failed MCP request with a 500 Bridge error, and other failed requests with nothing', async () => {
    await silenced(async () => {
      const h = harness({
        handle: async () => {
          throw new Error('store exploded');
        },
      });
      try {
        const s = h.last();
        s.open();
        await waitFor(() => s.sent.length === 1, 'the hello');
        s.emit('message', JSON.stringify({ type: 'file', id: 1, attachmentId: 'a1', baseUrl: '' }));
        s.emit('message', JSON.stringify(mcpFrame({ jsonrpc: '2.0', id: 3, method: 'tools/list' })));
        await waitFor(() => s.sent.length === 2, 'the error reply');
        const r = s.frames()[1];
        assert.deepEqual([r.type, r.id, r.status], ['mcp_result', 9, 500]);
        assert.deepEqual(JSON.parse(r.body).error, { code: -32603, message: 'Bridge error' });
      } finally {
        h.client.close();
      }
    });
  });

  it('reconnects with growing backoff after a drop, and after a hello that fails', async () => {
    await silenced(async () => {
      let helloFails = true;
      const h = harness({
        hello: async () => {
          if (helloFails) throw new Error('no tools');
          return { type: 'hello', version: 't', mode: 'live', toolsList: { tools: [] }, me: 'Me' };
        },
      });
      try {
        h.last().open();
        await waitFor(() => h.sockets.length === 2, 'a reconnect after the failed hello');
        assert.equal(h.sockets[0].readyState, 3);
        helloFails = false;
        h.last().open();
        await waitFor(() => h.last().sent.length === 1, 'the hello');
        h.last().close(1006);
        await waitFor(() => h.sockets.length === 3, 'a reconnect after the drop');
        await sleep(30);
        assert.equal(h.sockets.length, 3, 'one reconnect per drop');
      } finally {
        h.client.close();
      }
    });
  });

  it('drops a connection the gateway stopped pinging, and keeps one it pings', async () => {
    await silenced(async () => {
      const h = harness({
        timing: { firstRetryMs: 5, maxRetryMs: 20, jitterMs: 1, pingTimeoutMs: 150, watchdogMs: 10 },
      });
      try {
        const s = h.last();
        s.open();
        for (let i = 0; i < 8; i++) {
          await sleep(10);
          s.emit('ping');
        }
        assert.equal(s.readyState, 1, 'pinged regularly, so still open');
        await waitFor(() => s.readyState === 3, 'the watchdog to drop the silent connection');
        await waitFor(() => h.sockets.length === 2, 'a reconnect');
      } finally {
        h.client.close();
      }
    });
  });

  it('stops for good on close code 4000 (a newer bridge took over) and after close()', async () => {
    await silenced(async () => {
      const h = harness();
      h.last().open();
      h.last().close(CLOSE_REPLACED_BY_NEWER);
      assert.equal(h.replaced(), 1);
      await sleep(60);
      assert.equal(h.sockets.length, 1, 'no reconnect');
      const k = harness();
      k.last().open();
      k.client.close();
      await sleep(60);
      assert.deepEqual([k.sockets.length, k.replaced(), k.client.connected()], [1, 0, false]);
    });
  });
});
