import { ALL_SCOPES } from '../../src/auth/scopes.js';
import { loadToolConfig } from '../../src/config.js';
import type { Ctx } from '../../src/tools/context.js';
import { newMockStore, TZ } from './mock.js';

/** Tool config from env, with every tier on unless TIERS says otherwise. */
export const toolConfig = (env: Record<string, string> = {}) =>
  loadToolConfig(env as NodeJS.ProcessEnv, {
    timeZone: TZ,
    linkSecret: 'test-link-secret-0123456789abcdef',
    tiers: 'read,send,org,pa,gpt',
  });

/** A tool context on a pinned mock store with every scope; env feeds the tool config. */
export function makeCtx(env: Record<string, string> = {}, overrides: Partial<Ctx> = {}): Ctx {
  return {
    store: newMockStore(),
    cfg: toolConfig(env),
    baseUrl: 'https://imessage.example',
    sendLog: [],
    scopes: new Set(ALL_SCOPES),
    resourceMetadataUrl: 'https://imessage.example/.well-known/oauth-protected-resource/mcp',
    ...overrides,
  };
}
