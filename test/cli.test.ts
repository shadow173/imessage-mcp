import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { loadToolConfig } from '../src/config.js';
import { Journal } from '../src/lib/journal.js';
import { startLocalServer } from '../src/local/socketServer.js';
import type { MockStore } from '../src/mock/mockStore.js';
import { newMockStore } from './helpers/mock.js';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

let dir: string;
let socket: string;
let server: Server;
let store: MockStore;

function cli(
  args: string[],
  opts: {
    socket?: string;
    stdin?: string;
    timeoutMs?: number;
    intent?: string | null;
    /** Called with all stderr so far, after each chunk. */
    onStderr?: (err: string) => void;
  } = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    // TMPDIR keeps preview files inside the test's own directory.
    const env: NodeJS.ProcessEnv = { ...process.env, IMESSAGE_SOCKET: opts.socket ?? socket, TMPDIR: dir };
    if (opts.intent === null) delete env.IMESSAGE_INTENT;
    else env.IMESSAGE_INTENT = opts.intent ?? 'Automated CLI test of the iMessage tools';
    const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', 'src/cli.ts', ...args], { env });
    let out = '',
      err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
      opts.onStderr?.(err);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'imsg-cli-'));
  socket = join(dir, 'bridge.sock');
  store = newMockStore();
  const cfg = loadToolConfig({} as NodeJS.ProcessEnv, {
    timeZone: 'America/New_York',
    linkSecret: 'cli-test-link-secret-0123456789',
    tiers: 'read,send,org,pa,gpt',
  });
  const sendLog: number[] = [];
  const journal = new Journal(new DatabaseSync(':memory:'));
  server = startLocalServer(
    socket,
    store,
    (scopes, client) => ({
      store,
      cfg,
      baseUrl: 'https://imessage.example',
      sendLog,
      scopes: new Set(scopes),
      resourceMetadataUrl: '',
      client,
      journal: journal.sink,
    }),
    journal,
  );
  if (!server.listening) await once(server, 'listening');
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('imessage CLI', { concurrency: true }, () => {
  it('prints help and exits 64 on unknown commands', async () => {
    const h = await cli(['--help']);
    assert.equal(h.code, 0);
    assert.match(h.out, /watch/);
    assert.match(h.out, /Exit codes/);
    assert.equal((await cli(['nope'])).code, 64);
  });

  it('prints the package version without needing --intent', async () => {
    const v = await cli(['--version'], { intent: null });
    assert.equal(v.code, 0);
    assert.equal(v.out, `${PKG_VERSION}\n`);
  });

  it('requires --intent on commands that read or send (exit 64 with guidance)', async () => {
    const r = await cli(['find', 'Sam'], { intent: null });
    assert.equal(r.code, 64);
    assert.match(r.err, /--intent is required/);
    assert.match(r.err, /goal behind the workflow/);
    assert.equal(
      (await cli(['find', 'Sam', '--intent', 'User wants to see what is going on with Sam'], { intent: null })).code,
      0,
    );
    assert.equal((await cli(['tools'], { intent: null })).code, 0);
  });

  it('journals each call with its intent and client, readable with `imessage journal`', async () => {
    await cli(['find', 'Sam', '--intent', 'User is checking whether Sam replied about the cabin']);
    const j = await cli(['journal', '--json', '--tool', 'find'], { intent: null });
    assert.equal(j.code, 0, j.err);
    const entries = j.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l)) as { intent: string; client: string; ok: boolean; args: Record<string, unknown> }[];
    const e = entries.find((x) => x.intent === 'User is checking whether Sam replied about the cabin');
    assert.ok(e, 'the call is journaled with its intent');
    assert.equal(e!.client, 'local-cli');
    assert.equal(e!.ok, true);
    assert.equal('intent' in e!.args, false);
  });

  it('finds both Sams', async () => {
    const f = await cli(['find', 'Sam']);
    assert.equal(f.code, 0);
    assert.match(f.out, /Sam Ortiz/);
    assert.match(f.out, /Sam Lee/);
  });

  it('signals an ambiguous name with exit 4 and candidates', async () => {
    const amb = await cli(['read', 'Sam']);
    assert.equal(amb.code, 4);
    assert.match(amb.err, /Candidates/);
  });

  it('reads a conversation, and lists chats as JSON', async () => {
    const r = await cli(['read', 'Cabin Weekend', '--limit', '3']);
    assert.equal(r.code, 0);
    assert.match(r.out, /Cabin Weekend/);
    const j = await cli(['chats', '--needs-reply', '--json']);
    assert.equal(j.code, 0);
    assert.ok(Array.isArray(JSON.parse(j.out).conversations));
  });

  it('replays a send with the same --key and needs --confirm for strangers (exit 3)', async () => {
    // An explicit key: the automatic one includes the minute, so two runs straddling a minute would send twice.
    const a = await cli(['send', 'Sam Ortiz', 'found your charger', '--key', 'cli-test-0001', '--json']);
    const b = await cli(['send', 'Sam Ortiz', 'found your charger', '--key', 'cli-test-0001', '--json']);
    assert.equal(a.code, 0);
    assert.equal(JSON.parse(a.out).message_id, JSON.parse(b.out).message_id);
    const s = await cli(['send', '+15555550188', 'who is this?']);
    assert.equal(s.code, 3);
    assert.match(s.err, /confirmation_required/);
    assert.equal((await cli(['send', '+15555550188', 'who is this?', '--confirm'])).code, 0);
  });

  it('saves image previews to a file', async () => {
    const list = JSON.parse((await cli(['attachments', '--type', 'image', '--json'])).out);
    const id = list.attachments.find((a: any) => a.name === 'IMG_2231.HEIC').attachment_id;
    const o = await cli(['open', id]);
    const path = o.out.match(/Saved preview: (\S+)/)?.[1];
    assert.ok(path && existsSync(path));
  });

  it('watch --once exits 0 when the person writes, and 2 on timeout', async () => {
    let watching!: () => void;
    const started = new Promise<void>((r) => {
      watching = r;
    });
    const waiting = cli(['watch', '--from', 'Sam Ortiz', '--once', '--timeout', '60s'], {
      timeoutMs: 60_000,
      onStderr: (err) => /Watching for new messages/.test(err) && watching(),
    });
    await Promise.race([started, waiting]); // a watch that exits early fails below instead of hanging here
    store.receive('iMessage;+;chat58213', 'p_sam_lee', 'not this one');
    store.receive('iMessage;-;+15555550142', 'p_sam_ortiz', 'yep I am around');
    const w = await waiting;
    assert.equal(w.code, 0, w.err);
    assert.match(w.out, /Sam Ortiz in Sam Ortiz: yep I am around/);
    assert.doesNotMatch(w.out, /not this one/);
    const t = await cli(['watch', '--from', 'Jo', '--once', '--timeout', '2s'], { timeoutMs: 20_000 });
    assert.equal(t.code, 2);
    assert.match(t.err, /No matching message within 2s/);
  });

  it('documents 30min and 6mo, and refuses a bare 6m as ambiguous', async () => {
    const h = await cli(['--help']);
    assert.match(h.out, /30min/);
    assert.match(h.out, /6mo/);
    assert.doesNotMatch(h.out, /6m \(months\)/);
    const months = await cli(['search', 'cabin', '--after', '6m']);
    assert.equal(months.code, 1);
    assert.match(months.err, /ambiguous_unit/);
    assert.equal((await cli(['search', 'cabin', '--after', '6mo'])).code, 0);
  });

  it('remind passes --dismiss-when, lists, and clears', async () => {
    const r = await cli(['remind', 'Mom', '2h', '--dismiss-when', 'never', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).dismiss_when, 'never');
    const list = await cli(['remind', '--json']);
    assert.ok(
      JSON.parse(list.out).reminders.some(
        (x: any) => x.chat_id === 'iMessage;-;+15555550111' && x.dismiss_when === 'never',
      ),
    );
    assert.equal((await cli(['remind', 'Mom', '--clear'])).code, 0);
  });

  it('react adds and --remove takes away a tapback', async () => {
    const sent = JSON.parse((await cli(['send', 'Sam Ortiz', 'tapback target', '--json'])).out);
    assert.equal((await cli(['react', sent.message_id, 'love'])).code, 0);
    const removed = await cli(['react', sent.message_id, '--remove', '--json']);
    assert.equal(removed.code, 0, removed.err);
    assert.equal(JSON.parse(removed.out).status, 'removed');
  });

  it('group leave needs --confirm (exit 3)', async () => {
    const leave = await cli(['group', 'leave', 'Product Team']);
    assert.equal(leave.code, 3);
    assert.match(leave.err, /confirmation_required/);
  });

  it('explains a missing bridge with exit 5', async () => {
    const r = await cli(['status'], { socket: join(dir, 'missing.sock') });
    assert.equal(r.code, 5);
    assert.match(r.err, /bridge isn't running/);
  });

  it('works as a stdio MCP server', async () => {
    const lines =
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]
        .map((m) => JSON.stringify(m))
        .join('\n') + '\n';
    const r = await cli(['mcp'], { stdin: lines });
    const replies = r.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(replies.find((x) => x.id === 1).result.serverInfo, { name: 'imessage', version: PKG_VERSION });
    assert.ok(replies.find((x) => x.id === 2).result.tools.length >= 24);
  });
});
