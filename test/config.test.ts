import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { hashPassword, Signer, verifyPassword } from '../src/auth/crypto.js';
import {
  checkSocketPath,
  loadBridgeConfig,
  loadConfig,
  loadEnvFile,
  loadToolConfig,
  socketPath,
} from '../src/config.js';
import { captureConsole } from './helpers/console.js';
import { liveClockMockStore } from './helpers/mock.js';

type Env = Record<string, string>;
const load = (env: Env) => loadConfig(env as NodeJS.ProcessEnv);
const loadQuiet = async (env: Env) => (await captureConsole(() => load(env))).result;
const tools = (env: Env) =>
  loadToolConfig(env as NodeJS.ProcessEnv, { timeZone: 'UTC', linkSecret: 'l'.repeat(32), tiers: 'read,send' });

const SECRET = 's'.repeat(32);
let HASH: string;
/** Everything a production mock gateway needs; tests drop or change one thing at a time. */
let PROD: Env;
before(() => {
  HASH = hashPassword('correct horse battery staple');
  PROD = {
    MODE: 'mock',
    PUBLIC_URL: 'https://imessage.example/',
    AUTH_SIGNING_SECRET: SECRET,
    OWNER_PASSWORD_HASH: HASH,
  };
});

describe('gateway config fails closed unless DEV=1', () => {
  it('refuses to start with nothing set, on any host, and names every missing variable', () => {
    assert.throws(
      () => load({}),
      /^Error: Missing required environment variables: MODE, PUBLIC_URL, AUTH_SIGNING_SECRET, OWNER_PASSWORD_HASH\. For a local test server set DEV=1\.$/,
    );
    // The old check only looked for NODE_ENV or one hosting platform's variable; any other host got the defaults.
    assert.throws(
      () => load({ MODE: 'relay', BRIDGE_SECRET: 'b'.repeat(40) }),
      /Missing required environment variables: PUBLIC_URL, AUTH_SIGNING_SECRET, OWNER_PASSWORD_HASH, LINK_SECRET\./,
    );
    assert.throws(
      () => load({ ...PROD, MODE: 'relay' }),
      /Missing required environment variables: BRIDGE_SECRET, LINK_SECRET\./,
    );
  });

  it('refuses short secrets, a hash that is not scrypt, an unknown MODE and a plain-http PUBLIC_URL', () => {
    assert.throws(
      () => load({ ...PROD, AUTH_SIGNING_SECRET: 's'.repeat(31) }),
      /AUTH_SIGNING_SECRET must be at least 32/,
    );
    assert.throws(
      () => load({ ...PROD, MODE: 'relay', BRIDGE_SECRET: 'b'.repeat(31), LINK_SECRET: 'l'.repeat(32) }),
      /BRIDGE_SECRET must be at least 32/,
    );
    assert.throws(
      () => load({ ...PROD, MODE: 'relay', BRIDGE_SECRET: 'b'.repeat(32), LINK_SECRET: 'l'.repeat(31) }),
      /LINK_SECRET must be at least 32/,
    );
    assert.throws(() => load({ ...PROD, LINK_SECRET: 'short' }), /LINK_SECRET must be at least 32/);
    assert.throws(() => load({ ...PROD, OWNER_PASSWORD_HASH: 'hunter2' }), /OWNER_PASSWORD_HASH is not a scrypt hash/);
    assert.throws(() => load({ ...PROD, MODE: 'prod' }), /MODE must be one of mock, relay \(got "prod"\)/);
    assert.throws(() => load({ ...PROD, PUBLIC_URL: 'http://imessage.example' }), /PUBLIC_URL must use https/);
    assert.throws(() => load({ ...PROD, PUBLIC_URL: 'imessage.example' }), /PUBLIC_URL must be a URL/);
    assert.equal(load({ ...PROD, PUBLIC_URL: 'http://localhost:3000' }).publicUrl, 'http://localhost:3000');
  });

  it('runs as production with the configured secrets, binding every interface behind a proxy', async () => {
    const cfg = load(PROD);
    assert.equal(cfg.production, true);
    assert.equal(cfg.publicUrl, 'https://imessage.example');
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.auth.signingSecret, SECRET);
    assert.equal(cfg.auth.ownerPasswordHash, HASH);
    assert.equal(load({ ...PROD, HOST: '127.0.0.1' }).host, '127.0.0.1');
    // A plain OWNER_PASSWORD does nothing in production.
    const { result, lines } = await captureConsole(() => load({ ...PROD, OWNER_PASSWORD: 'dev-password' }));
    assert.equal(verifyPassword('dev-password', result.auth.ownerPasswordHash), false);
    assert.match(lines.join('\n'), /OWNER_PASSWORD is ignored without DEV=1/);
  });

  it('DEV=1 prints a random one-off password, binds loopback, and refuses NODE_ENV=production', async () => {
    const { result: cfg, lines } = await captureConsole(() => load({ DEV: '1' }));
    assert.equal(cfg.production, false);
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.publicUrl, null);
    const password = /owner password for this run is (\S+)/.exec(lines.join('\n'))?.[1];
    assert.ok(password && password.length >= 12, lines.join('\n'));
    assert.equal(verifyPassword(password, cfg.auth.ownerPasswordHash), true);
    assert.equal(verifyPassword('dev-password', cfg.auth.ownerPasswordHash), false);
    const again = await loadQuiet({ DEV: '1' });
    assert.notEqual(again.auth.signingSecret, cfg.auth.signingSecret, 'a random signing key per run');
    assert.throws(
      () => load({ DEV: '1', NODE_ENV: 'production' }),
      /DEV=1 cannot be combined with NODE_ENV=production/,
    );
  });

  it('createApp refuses a production config without PUBLIC_URL, and a call with neither a store nor a hub', () => {
    const cfg = { ...load(PROD), publicUrl: null };
    assert.throws(() => createApp(cfg, { store: liveClockMockStore() }), /PUBLIC_URL is required unless DEV=1/);
    assert.throws(() => createApp(load(PROD), {}), /needs a store \(mock mode\) or a relay hub/);
  });

  it('takes the issuer from PUBLIC_URL, never from forwarded headers, outside DEV', async () => {
    const { app } = createApp(load(PROD), { store: liveClockMockStore() });
    const res = await app.request('http://10.0.0.5/.well-known/oauth-authorization-server', {
      headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    });
    const meta = await res.json();
    assert.equal(meta.issuer, 'https://imessage.example');
    assert.equal(meta.token_endpoint, 'https://imessage.example/token');
  });

  it('DEV without PUBLIC_URL takes the issuer from the request and warns once', async () => {
    const { app } = createApp(await loadQuiet({ DEV: '1' }), { store: liveClockMockStore() });
    const { result: issuers, lines } = await captureConsole(async () => {
      const out: string[] = [];
      for (const host of ['a.localhost:3000', 'b.localhost:3000']) {
        const res = await app.request('http://x/.well-known/oauth-authorization-server', { headers: { host } });
        out.push((await res.json()).issuer);
      }
      return out;
    });
    assert.deepEqual(issuers, ['http://a.localhost:3000', 'http://b.localhost:3000']);
    assert.equal(lines.filter((l) => /issuer is taken from request headers/.test(l)).length, 1);
  });
});

describe('environment values must parse', () => {
  it('booleans take true/false, 1/0, yes/no and on/off in any case; blank means the default', () => {
    for (const [v, want] of [
      ['true', true],
      ['YES', true],
      ['On', true],
      ['1', true],
      ['false', false],
      ['No', false],
      ['off', false],
      ['0', false],
    ] as const)
      assert.equal(tools({ SEND_ENABLED: v }).sendEnabled, want, v);
    assert.equal(tools({ REDACT_CODES: '  ' }).redactCodes, true);
    for (const v of ['maybe', 'enabled', 'tru'])
      assert.throws(
        () => tools({ REDACT_CODES: v }),
        new RegExp(`REDACT_CODES must be true or false \\(got "${v}"\\)`),
      );
  });

  it('whole numbers must be whole and in range; 0 still blocks sending', async () => {
    assert.equal(tools({ SEND_RATE_LIMIT_PER_HOUR: '0' }).sendRateLimitPerHour, 0);
    for (const v of ['-1', '1.5', 'ten', '1e3', '0x10'])
      assert.throws(() => tools({ SEND_RATE_LIMIT_PER_HOUR: v }), /SEND_RATE_LIMIT_PER_HOUR must be a whole number/);
    assert.throws(
      () => load({ ...PROD, ACCESS_TOKEN_TTL_S: '59' }),
      /ACCESS_TOKEN_TTL_S must be a whole number from 60/,
    );
    assert.throws(() => load({ ...PROD, PORT: '70000' }), /PORT must be a whole number from 0 to 65535/);
    assert.equal((await loadQuiet({ DEV: '1', TOKEN_VERSION: '3' })).auth.tokenVersion, 3);
  });

  it('time zones and tiers are checked; read is always on', () => {
    assert.throws(() => tools({ OWNER_TZ: 'Mars/Phobos' }), /OWNER_TZ must be an IANA time zone/);
    assert.equal(tools({ OWNER_TZ: 'Europe/London' }).timeZone, 'Europe/London');
    assert.throws(() => tools({ TIERS: 'read,bogus' }), /TIERS has unknown tiers bogus/);
    assert.deepEqual([...tools({ TIERS: 'send' }).tiers].sort(), ['read', 'send']);
  });

  it('SEND_ALLOWLIST unset means known contacts; set but blank means nobody', () => {
    assert.deepEqual(tools({}).sendAllowlist, { mode: 'known', entries: [] });
    assert.deepEqual(tools({ SEND_ALLOWLIST: ' ' }).sendAllowlist, { mode: 'list', entries: [] });
    assert.deepEqual(tools({ SEND_ALLOWLIST: 'p_jo, +15555550133' }).sendAllowlist, {
      mode: 'list',
      entries: ['p_jo', '+15555550133'],
    });
  });

  it('the bridge needs https and both secrets for a remote gateway, runs local-only without one, and checks PRIVATE_API', () => {
    const base = { HOME: '/nonexistent-home', OWNER_TZ: 'UTC' };
    const bridge = (env: Env) => loadBridgeConfig({ ...base, ...env } as NodeJS.ProcessEnv);
    const secrets = { BRIDGE_SECRET: 'b'.repeat(32), LINK_SECRET: 'l'.repeat(32) };
    assert.equal(bridge({}).gatewayUrl, null);
    assert.equal(bridge({ GATEWAY_URL: 'https://gw.example/', ...secrets }).gatewayUrl, 'https://gw.example');
    assert.equal(bridge({ GATEWAY_URL: 'http://localhost:3000', ...secrets }).gatewayUrl, 'http://localhost:3000');
    assert.throws(() => bridge({ GATEWAY_URL: 'http://gw.example', ...secrets }), /GATEWAY_URL must use https/);
    assert.throws(
      () => bridge({ GATEWAY_URL: 'https://gw.example', LINK_SECRET: secrets.LINK_SECRET }),
      /BRIDGE_SECRET must be too/,
    );
    assert.throws(
      () => bridge({ GATEWAY_URL: 'https://gw.example', ...secrets, LINK_SECRET: 'l'.repeat(31) }),
      /LINK_SECRET must be too: at least 32 characters/,
    );
    assert.equal(bridge({ LINK_SECRET: 'short' }).gatewayUrl, null, 'local only, links are never minted');
    assert.throws(() => bridge({ PRIVATE_API: 'yes' }), /PRIVATE_API must be one of off, imsg/);
    assert.equal(bridge({}).chatDbPath, '/nonexistent-home/Library/Messages/chat.db');
    assert.equal(bridge({ PRIVATE_API: 'imsg' }).tools.tiers.has('pa'), true);
    assert.equal(bridge({}).tools.tiers.has('pa'), false);
  });

  it('the bridge and the CLI find the socket the same way: IMESSAGE_SOCKET, then LOCAL_SOCKET, then DATA_DIR', () => {
    const home = { HOME: '/nonexistent-home' };
    const both = (env: Env) => {
      const path = socketPath({ ...home, ...env } as NodeJS.ProcessEnv);
      assert.equal(loadBridgeConfig({ ...home, OWNER_TZ: 'UTC', ...env } as NodeJS.ProcessEnv).socketPath, path);
      return path;
    };
    assert.equal(both({}), '/nonexistent-home/Library/Application Support/imessage-mcp/bridge.sock');
    assert.equal(both({ DATA_DIR: '/data' }), '/data/bridge.sock');
    assert.equal(both({ DATA_DIR: '/data', LOCAL_SOCKET: '/old.sock' }), '/old.sock');
    assert.equal(both({ LOCAL_SOCKET: '/old.sock', IMESSAGE_SOCKET: '/new.sock' }), '/new.sock');
    assert.equal(both({ IMESSAGE_SOCKET: '  ', DATA_DIR: '/data' }), '/data/bridge.sock');
  });

  it('refuses a socket path too long for a Unix socket instead of listening somewhere else', () => {
    const long = socketPath({ HOME: '/nonexistent-home', DATA_DIR: `/${'d'.repeat(120)}` } as NodeJS.ProcessEnv);
    assert.throws(
      () => checkSocketPath(long),
      /The local socket path is 133 bytes, over the 10[37] a Unix socket allows: .*Set IMESSAGE_SOCKET, or DATA_DIR/,
    );
    assert.throws(() => checkSocketPath(`/${'é'.repeat(60)}`), /is 121 bytes/, 'counts bytes (61 characters here)');
    checkSocketPath(`/${'s'.repeat(100)}`);
  });

  it('reads the bridge env file: KEY=value lines, quotes stripped, comments skipped, nothing when it is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imsg-envfile-'));
    try {
      const file = join(dir, 'bridge.env');
      writeFileSync(
        file,
        [
          '# comment',
          'GATEWAY_URL=https://gw.example',
          '  BRIDGE_SECRET = "quoted value"  ',
          "LINK_SECRET='single'",
          '#HIDE=commented out',
          'lower=ignored',
          'EMPTY=',
        ].join('\n'),
      );
      assert.deepEqual(loadEnvFile({ BRIDGE_ENV_FILE: file }), {
        GATEWAY_URL: 'https://gw.example',
        BRIDGE_SECRET: 'quoted value',
        LINK_SECRET: 'single',
        EMPTY: '',
      });
      assert.deepEqual(loadEnvFile({ HOME: dir }), {}, 'no ~/.config/imessage-mcp/bridge.env under this HOME');
      assert.deepEqual(loadEnvFile({ BRIDGE_ENV_FILE: join(dir, 'missing.env') }), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tokens other than client ids need a positive lifetime', async () => {
    const signer = new Signer(SECRET);
    for (const ttl of [null, 0, -60, Number.NaN, Number.POSITIVE_INFINITY])
      await assert.rejects(signer.sign('at', { sub: 'owner' }, ttl), /needs a positive lifetime/, String(ttl));
    assert.ok(await signer.verify('client', await signer.sign('client', { sub: 'c' }, null)));
  });
});
