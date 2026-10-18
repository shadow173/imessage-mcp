// A stand-in for `imsg rpc` in imsgRpc tests: JSON-RPC 2.0, one object per line on stdio. The method picks the
// behaviour; FAKE_IMSG_MODE=exit-at-start makes it quit before reading anything. Run as `fake-imsg.mjs rpc`.
import { createInterface } from 'node:readline';

if (process.env.FAKE_IMSG_MODE === 'exit-at-start') process.exit(3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Writes go out one after another, so a reply sent in pieces is never interleaved with another reply.
let out = Promise.resolve();
const write = (fn) => {
  out = out.then(fn);
  return out;
};
const send = (obj) => write(() => process.stdout.write(`${JSON.stringify(obj)}\n`));

createInterface({ input: process.stdin }).on('line', async (line) => {
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case 'echo':
      return send({ jsonrpc: '2.0', id, result: params });
    case 'env':
      return send({ jsonrpc: '2.0', id, result: { keys: Object.keys(process.env).sort() } });
    case 'noisy':
      // Diagnostics, a notification and a stray reply come first; only the matching reply counts.
      write(() => process.stdout.write('not json\n\n'));
      send({ jsonrpc: '2.0', method: 'watch.event', params: {} });
      send({ jsonrpc: '2.0', id: 999_999, result: 'nobody asked' });
      return send({ jsonrpc: '2.0', id, result: { ok: true } });
    case 'split': {
      const text = `${JSON.stringify({ jsonrpc: '2.0', id, result: { text: 'arrived in pieces ✓' } })}\n`;
      const bytes = Buffer.from(text);
      return write(async () => {
        for (const part of [bytes.subarray(0, 7), bytes.subarray(7, 30), bytes.subarray(30)]) {
          process.stdout.write(part);
          await sleep(20);
        }
      });
    }
    case 'late':
      await sleep(params.ms);
      return send({ jsonrpc: '2.0', id, result: { late: true } });
    case 'fail':
      return send({
        jsonrpc: '2.0',
        id,
        error: { code: -32010, message: 'chat not found', data: { disposition: 'not_delivered', retry_safe: true } },
      });
    case 'status':
      return send({ jsonrpc: '2.0', id, result: { bridge: { ready: false, error: 'helper not loaded\nmore' } } });
    case 'hang':
      return;
    case 'die':
      process.exit(1);
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
});
