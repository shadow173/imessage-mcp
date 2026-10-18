import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, parsePasswordHash, randomId } from './auth/crypto.js';

export type Tier = 'read' | 'send' | 'org' | 'pa' | 'gpt';
const TIERS: readonly Tier[] = ['read', 'send', 'org', 'pa', 'gpt'];

type Env = NodeJS.ProcessEnv;

const list = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Unset or blank means "use the default". Everything else must parse, or the process refuses to start. */
const raw = (env: Env, name: string) => env[name]?.trim() || undefined;

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);
function flag(env: Env, name: string, dflt: boolean): boolean {
  const v = raw(env, name)?.toLowerCase();
  if (v === undefined) return dflt;
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  throw new Error(`${name} must be true or false (got "${env[name]}").`);
}

function num(env: Env, name: string, dflt: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = raw(env, name);
  if (v === undefined) return dflt;
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!(n >= min && n <= max)) throw new Error(`${name} must be a whole number from ${min} to ${max} (got "${v}").`);
  return n;
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], dflt: T): T {
  const v = raw(env, name) ?? dflt;
  if (!allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${v}").`);
  return v as T;
}

function timeZone(env: Env, dflt: string): string {
  const tz = raw(env, 'OWNER_TZ') ?? dflt;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`OWNER_TZ must be an IANA time zone such as Europe/London (got "${tz}").`);
  }
  return tz;
}

/** https anywhere, or plain http on this machine only. */
function httpUrl(env: Env, name: string): string | null {
  const v = raw(env, name);
  if (v === undefined) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} must be a URL such as https://imessage.example (got "${v}").`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))
    throw new Error(`${name} must use https (plain http is allowed only for localhost); got "${v}".`);
  return v.replace(/\/+$/, '');
}

const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** How the tools behave. Runs wherever the tools run: the Mac bridge, or the gateway in mock mode. */
export interface ToolConfig {
  tiers: Set<Tier>;
  timeZone: string;
  /** Hides verification codes in message text, OCR/extracted attachment text and the search index. */
  redactCodes: boolean;
  /**
   * Local kill switch for everything recipients see (sends, scheduled sends, tapbacks, edits, read receipts, typing,
   * group changes); unsend stays allowed.
   */
  sendEnabled: boolean;
  /**
   * "known" = anyone with a Contacts name (a brand-new number is blocked); "all"; or a list of person_ids / addresses /
   * chat_ids, where a group passes only when its chat_id or every member is listed.
   */
  sendAllowlist: { mode: 'known' | 'all' | 'list'; entries: string[] };
  sendRateLimitPerHour: number;
  /** Signs file and citation links. Shared by gateway and bridge so links minted on the Mac verify on the gateway. */
  linkSecret: string;
  autoReply: boolean;
}

export function loadToolConfig(
  env: Env,
  defaults: { timeZone: string; linkSecret: string; tiers: string },
): ToolConfig {
  const named = list(env.TIERS ?? defaults.tiers);
  const unknown = named.filter((t) => !TIERS.includes(t as Tier));
  if (unknown.length) throw new Error(`TIERS has unknown tiers ${unknown.join(', ')}; use ${TIERS.join(', ')}.`);
  const tiers = new Set(named as Tier[]);
  tiers.add('read');
  // Set but blank stays a list with no entries (nobody), never the more open default.
  const allow = (env.SEND_ALLOWLIST ?? 'known').trim();
  return {
    tiers,
    timeZone: timeZone(env, defaults.timeZone),
    redactCodes: flag(env, 'REDACT_CODES', true),
    sendEnabled: flag(env, 'SEND_ENABLED', true),
    sendAllowlist:
      allow === 'known' || allow === 'all' ? { mode: allow, entries: [] } : { mode: 'list', entries: list(allow) },
    sendRateLimitPerHour: num(env, 'SEND_RATE_LIMIT_PER_HOUR', 30),
    linkSecret: raw(env, 'LINK_SECRET') ?? defaults.linkSecret,
    autoReply: flag(env, 'MOCK_AUTO_REPLY', true),
  };
}

export interface AuthConfig {
  /** HMAC key for every token, client id and DCR client secret. Must be stable across deploys or clients reconnect. */
  signingSecret: string;
  ownerPasswordHash: string;
  tokenVersion: number;
  accessTtlS: number;
  refreshTtlS: number;
  extraRedirectUris: string[];
  cimdHosts: string[];
  allowInsecureCimd: boolean;
}

/** The public gateway. */
export interface Config {
  port: number;
  /** Interface to bind: HOST, else 127.0.0.1 with DEV=1 and 0.0.0.0 otherwise (a public server behind a proxy). */
  host: string;
  /** Everything except DEV=1. Production requires real secrets and never trusts request headers for its origin. */
  production: boolean;
  /** Canonical origin. Always set in production; issuer and resource come only from here. Null only with DEV=1. */
  publicUrl: string | null;
  /** mock: tools run here against seeded data. relay: tools run on the Mac bridge. */
  mode: 'mock' | 'relay';
  /** Shared secret the Mac bridge presents when it connects. */
  bridgeSecret: string | null;
  auth: AuthConfig;
  tools: ToolConfig;
}

/**
 * Fails closed: unless DEV=1, every secret must be set explicitly and the process refuses to start otherwise, whatever
 * the host. DEV=1 is for a server on this machine: random keys, a printed one-off password, the origin taken from the
 * request.
 */
export function loadConfig(env: Env = process.env): Config {
  const dev = flag(env, 'DEV', false);
  if (dev && env.NODE_ENV === 'production') throw new Error('DEV=1 cannot be combined with NODE_ENV=production.');
  const required = dev
    ? []
    : [
        'MODE',
        'PUBLIC_URL',
        'AUTH_SIGNING_SECRET',
        'OWNER_PASSWORD_HASH',
        ...(raw(env, 'MODE') === 'relay' ? ['BRIDGE_SECRET', 'LINK_SECRET'] : []),
      ];
  const missing = required.filter((k) => !raw(env, k));
  if (missing.length)
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. For a local test server set DEV=1.`,
    );
  const mode = oneOf(env, 'MODE', ['mock', 'relay'] as const, 'mock');
  if (!dev && (raw(env, 'AUTH_SIGNING_SECRET') ?? '').length < 32)
    throw new Error('AUTH_SIGNING_SECRET must be at least 32 characters.');
  if (!dev && mode === 'relay' && (raw(env, 'BRIDGE_SECRET') ?? '').length < 32)
    throw new Error('BRIDGE_SECRET must be at least 32 characters.');
  // Anyone holding one /view or /files link could try to guess a short LINK_SECRET offline and then sign their own.
  const linkSecret = raw(env, 'LINK_SECRET');
  if (!dev && linkSecret !== undefined && linkSecret.length < 32)
    throw new Error('LINK_SECRET must be at least 32 characters.');

  let signingSecret = raw(env, 'AUTH_SIGNING_SECRET') ?? '';
  if (!signingSecret) {
    signingSecret = randomBytes(32).toString('hex');
    console.warn('DEV: AUTH_SIGNING_SECRET not set, so tokens are signed with a random key and reset on restart.');
  }
  let ownerPasswordHash = raw(env, 'OWNER_PASSWORD_HASH') ?? '';
  if (ownerPasswordHash && !parsePasswordHash(ownerPasswordHash))
    throw new Error('OWNER_PASSWORD_HASH is not a scrypt hash. Make one with `npm run hash-password`.');
  if (!dev && env.OWNER_PASSWORD) console.warn('OWNER_PASSWORD is ignored without DEV=1; OWNER_PASSWORD_HASH is used.');
  if (!ownerPasswordHash) {
    let password = env.OWNER_PASSWORD ?? '';
    if (!password) {
      password = randomId(12);
      console.warn(
        `DEV: owner password for this run is ${password} (set OWNER_PASSWORD or OWNER_PASSWORD_HASH to choose one).`,
      );
    }
    ownerPasswordHash = hashPassword(password);
  }

  return {
    port: num(env, 'PORT', 3000, 0, 65535),
    host: raw(env, 'HOST') ?? (dev ? '127.0.0.1' : '0.0.0.0'),
    production: !dev,
    publicUrl: httpUrl(env, 'PUBLIC_URL'),
    mode,
    bridgeSecret: raw(env, 'BRIDGE_SECRET') ?? null,
    auth: {
      signingSecret,
      ownerPasswordHash,
      tokenVersion: num(env, 'TOKEN_VERSION', 1),
      accessTtlS: num(env, 'ACCESS_TOKEN_TTL_S', 3600, 60),
      // Each refresh issues a fresh token, so this is how long a client may sit unused before it must reconnect.
      refreshTtlS: num(env, 'REFRESH_TOKEN_TTL_S', 30 * 86400, 60),
      extraRedirectUris: list(env.ALLOWED_REDIRECT_URIS),
      cimdHosts: list(env.CIMD_HOSTS ?? 'chatgpt.com,claude.ai,claude.com'),
      allowInsecureCimd: dev && flag(env, 'ALLOW_INSECURE_CIMD', false),
    },
    tools: loadToolConfig(env, {
      timeZone: systemTimeZone(),
      linkSecret: createHmac('sha256', signingSecret).update('signed-links').digest('hex'),
      tiers: 'read,send,org,pa,gpt',
    }),
  };
}

/** The bridge's data folder: DATA_DIR, or ~/Library/Application Support/imessage-mcp. */
const dataDir = (env: Env) =>
  env.DATA_DIR ?? join(env.HOME ?? homedir(), 'Library', 'Application Support', 'imessage-mcp');

/**
 * The bridge's local socket, where the CLI finds it: IMESSAGE_SOCKET, else LOCAL_SOCKET (the bridge's older name for
 * it, still read), else bridge.sock in the data folder. The bridge and the CLI both resolve it here.
 */
export function socketPath(env: Env = process.env): string {
  return raw(env, 'IMESSAGE_SOCKET') ?? raw(env, 'LOCAL_SOCKET') ?? join(dataDir(env), 'bridge.sock');
}

/** A Unix socket path holds 104 bytes on macOS (108 on Linux), counting the closing NUL. */
const MAX_SOCKET_PATH_BYTES = process.platform === 'linux' ? 107 : 103;

/** Throws when path is too long for a Unix socket. Node would cut it short without an error and listen elsewhere. */
export function checkSocketPath(path: string): void {
  const n = Buffer.byteLength(path);
  if (n > MAX_SOCKET_PATH_BYTES)
    throw new Error(
      `The local socket path is ${n} bytes, over the ${MAX_SOCKET_PATH_BYTES} a Unix socket allows: ${path}. Set IMESSAGE_SOCKET, or DATA_DIR, to a shorter path.`,
    );
}

/** Loads an entry point's config. A bad value prints one line and exits 1, without a stack trace. */
export function loadOrExit<T>(load: () => T): T {
  try {
    return load();
  } catch (e) {
    console.error(`imessage-mcp: ${(e as Error).message}`);
    process.exit(1);
  }
}

/**
 * Reads ~/.config/imessage-mcp/bridge.env (or BRIDGE_ENV_FILE): KEY=value lines, quotes stripped, # comments.
 * Returned rather than copied into process.env, so the secrets never reach child processes.
 */
export function loadEnvFile(env: Env): Record<string, string> {
  const file = env.BRIDGE_ENV_FILE ?? join(env.HOME ?? homedir(), '.config', 'imessage-mcp', 'bridge.env');
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** The Mac bridge. Reads ~/.config/imessage-mcp/bridge.env via the LaunchAgent or the shell. */
export interface BridgeConfig {
  gatewayUrl: string | null;
  bridgeSecret: string | null;
  dataDir: string;
  socketPath: string;
  chatDbPath: string;
  addressBookDir: string;
  attachmentsStageDir: string;
  /** chat_ids, phone numbers, emails or names the agent must never see. */
  hide: string[];
  /** imsg: reactions, edit, unsend, read, typing, replies, effects and groups through imsg's helper inside Messages. */
  privateApi: 'off' | 'imsg';
  imsgPath: string;
  /** Relaunch Messages with the helper when it isn't loaded (quits Messages; at most every 10 minutes). */
  imsgAutoLaunch: boolean;
  tools: ToolConfig;
}

export function loadBridgeConfig(env: Env = process.env): BridgeConfig {
  const home = env.HOME ?? homedir();
  const privateApi = oneOf(env, 'PRIVATE_API', ['off', 'imsg'] as const, 'off');
  const gatewayUrl = httpUrl(env, 'GATEWAY_URL');
  if (gatewayUrl && !raw(env, 'BRIDGE_SECRET'))
    throw new Error('GATEWAY_URL is set, so BRIDGE_SECRET must be too, with the same value as on the gateway.');
  if (gatewayUrl && (raw(env, 'LINK_SECRET') ?? '').length < 32)
    throw new Error(
      'GATEWAY_URL is set, so LINK_SECRET must be too: at least 32 characters, the same value as on the gateway.',
    );
  return {
    gatewayUrl,
    bridgeSecret: raw(env, 'BRIDGE_SECRET') ?? null,
    dataDir: dataDir(env),
    socketPath: socketPath(env),
    chatDbPath: env.CHAT_DB ?? join(home, 'Library', 'Messages', 'chat.db'),
    addressBookDir: env.ADDRESSBOOK_DIR ?? join(home, 'Library', 'Application Support', 'AddressBook'),
    attachmentsStageDir: env.ATTACHMENT_STAGE_DIR ?? join(home, 'Library', 'Messages', 'Attachments', 'imessage-mcp'),
    hide: list(env.HIDE),
    privateApi,
    imsgPath: env.IMSG_PATH ?? 'imsg',
    imsgAutoLaunch: flag(env, 'IMSG_AUTO_LAUNCH', false),
    tools: loadToolConfig(env, {
      timeZone: systemTimeZone(),
      linkSecret: raw(env, 'LINK_SECRET') ?? randomBytes(32).toString('hex'),
      tiers: privateApi === 'imsg' ? 'read,send,org,pa,gpt' : 'read,send,org,gpt',
    }),
  };
}
