import { loadConfig } from '../../src/config.js';
import { TZ } from './mock.js';
import { cheapPasswordHash } from './oauth.js';

/**
 * A DEV gateway config with a known owner password, a fixed signing secret and the test time zone, so it prints no
 * warnings and renders the same on any machine. env adds or overrides variables (MODE, BRIDGE_SECRET, ...).
 */
export const devGatewayConfig = (password: string, env: Record<string, string> = {}) =>
  loadConfig({
    DEV: '1',
    OWNER_PASSWORD_HASH: cheapPasswordHash(password),
    AUTH_SIGNING_SECRET: 'dev-gateway-test-signing-secret-0123456789',
    OWNER_TZ: TZ,
    MOCK_AUTO_REPLY: 'false',
    ...env,
  } as NodeJS.ProcessEnv);
