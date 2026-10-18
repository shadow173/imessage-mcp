import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { MINUTE_MS } from '../lib/units.js';
import { childEnv } from './macos.js';

const execFileP = promisify(execFile);

/** A JSON-RPC error from `imsg rpc`, with its delivery disposition when the server reports one. */
export class ImsgError extends Error {
  constructor(
    public code: number,
    message: string,
    public disposition?: string,
    public retrySafe?: boolean,
  ) {
    super(message);
  }
}

export interface ImsgStatus {
  bridgeReady: boolean;
  reason?: string;
  methods: string[];
}

/** What the live store needs from the private-API bridge. A fake implements this in tests. */
export interface PrivateApi {
  status(): Promise<ImsgStatus>;
  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

type Pending = {
  /** Settles call<T>() with the reply's result, which is trusted to be a T. */
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  child: ChildProcessWithoutNullStreams;
};

/**
 * One long-lived `imsg rpc` child (JSON-RPC 2.0, one object per line on stdio).
 * Reactions, edits, unsends, read state, typing, inline replies, effects and group changes go through imsg's
 * helper injected into Messages. It restarts on demand if the child exits.
 */
export class ImsgRpc implements PrivateApi {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private lastLaunch = 0;

  /**
   * bin should be an absolute path (the bridge resolves it at startup). opts.env adds variables to imsg's minimal
   * environment, e.g. IMSG_* settings.
   */
  constructor(
    private bin = 'imsg',
    private opts: { autoLaunch?: boolean; env?: Record<string, string> } = {},
  ) {}

  /** Fails every call waiting on this child, e.g. when it exits or never started. */
  private failPending(child: ChildProcessWithoutNullStreams, err: () => ImsgError) {
    for (const [id, p] of this.pending) {
      if (p.child !== child) continue;
      clearTimeout(p.timer);
      p.reject(err());
      this.pending.delete(id);
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    // A child that exited, or never started (spawn failed: exitCode stays null), is replaced.
    if (this.child && this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined)
      return this.child;
    const child = spawn(this.bin, ['rpc'], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(this.opts.env) });
    this.child = child;
    this.buffer = '';
    // Writing to a child that already died raises EPIPE here; the exit and error handlers fail the calls.
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id !== 'number') continue; // notifications (watch events) are not used here
        const p = this.pending.get(msg.id);
        if (!p) continue;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          const d = (msg.error.data && typeof msg.error.data === 'object' ? msg.error.data : {}) as {
            disposition?: string;
            retry_safe?: boolean;
          };
          p.reject(new ImsgError(msg.error.code, msg.error.message, d.disposition, d.retry_safe));
        } else p.resolve(msg.result);
      }
    });
    child.stderr.on('data', () => {
      /* human diagnostics; never parsed */
    });
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      this.failPending(child, () => new ImsgError(-32603, 'imsg rpc exited', 'may_have_completed', false));
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (this.child === child) this.child = null;
      // No pid: the binary never started, so nothing reached Messages and a retry is safe.
      const started = child.pid !== undefined;
      const message =
        e.code === 'ENOENT'
          ? `imsg not found at ${this.bin}`
          : `imsg rpc ${started ? 'failed' : "didn't start"}: ${e.message}`;
      this.failPending(child, () =>
        started
          ? new ImsgError(-32603, message, 'may_have_completed', false)
          : new ImsgError(-32000, message, 'not_started', true),
      );
    });
    return child;
  }

  /**
   * The default stays under the gateway's 110 s relay timeout, so the Mac's own outcome_unknown reaches the agent
   * first.
   */
  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs = 90_000): Promise<T> {
    const child = this.ensureChild();
    if (!child.stdin.writable)
      return Promise.reject(new ImsgError(-32000, `imsg rpc is not running (${this.bin})`, 'not_started', true));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ImsgError(-32001, `imsg ${method} timed out`, 'still_in_flight', false));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, child });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Whether the injected helper is up. Optionally relaunches Messages with it, at most every 10 minutes. */
  async status(): Promise<ImsgStatus> {
    const read = async () => {
      const s = await this.call<{ bridge?: { ready?: boolean; error?: string }; methods?: string[] }>(
        'status',
        {},
        20_000,
      );
      return { bridgeReady: !!s.bridge?.ready, reason: s.bridge?.error, methods: s.methods ?? [] };
    };
    try {
      let s = await read();
      if (!s.bridgeReady && this.opts.autoLaunch && Date.now() - this.lastLaunch > 10 * MINUTE_MS) {
        this.lastLaunch = Date.now();
        await execFileP(this.bin, ['launch', '--json'], {
          timeout: 90_000,
          env: childEnv({ ...this.opts.env, IMSG_LAUNCH_READY_TIMEOUT: '60' }),
        }).catch(() => undefined);
        s = await read();
      }
      return s;
    } catch (e) {
      return { bridgeReady: false, reason: (e as Error).message, methods: [] };
    }
  }

  stop() {
    this.child?.stdin.end();
  }
}
