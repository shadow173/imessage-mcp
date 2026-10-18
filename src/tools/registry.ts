// Tool definitions and their registration on the MCP server: unknown arguments, scopes and errors are handled here,
// once for every tool.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { ALL_SCOPES, SCOPE_INFO, TIER_SCOPE } from '../auth/scopes.js';
import type { Tier, ToolConfig } from '../config.js';
import { PRIVATE_API_OFF, ToolError } from '../lib/errors.js';
import { zIntent, zIntentOptional } from '../lib/intent.js';
import { describeUnknown, suggestArg } from './argHints.js';
import { tierOf } from './catalog.js';
import type { Ctx } from './context.js';
import { errorResult } from './results.js';

/**
 * The ChatGPT search/fetch contract: intent stays optional so deep research keeps working, and results keep one content
 * block.
 */
const CHATGPT_CONTRACT = new Set(['search', 'fetch']);

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const LOCAL_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const SENDS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

type Shape = Record<string, z.ZodType>;
type Args<S extends Shape> = z.infer<z.ZodObject<S>>;

/**
 * One tool. Everything but the handler is what tools/list shows, and depends on config at most, never on the store, so
 * the tools can be listed without one.
 */
export interface ToolDef<S extends Shape = Shape> {
  name: string;
  /** Must match the tool's entry in tools/catalog.ts. */
  tier: Tier;
  title: string;
  /** A function when the wording depends on config (the Private API tier, an explicit allowlist). */
  description: string | ((cfg: ToolConfig) => string);
  inputSchema: S;
  annotations: ToolAnnotations;
  outputSchema?: Shape;
  /**
   * The scope this call needs when it depends on the arguments (e.g. mark_read unread=true needs only organize).
   * Defaults to the tier's scope.
   */
  scopeFor?: (args: Args<S>) => string | undefined;
  /** Appended to the insufficient_scope Fix: a way to do the job without more permission. */
  scopeHint?: string | ((args: Args<S>, ctx: Ctx) => string | undefined);
  /** ToolErrors it throws become error results the model can act on. */
  handler: (args: Args<S>, ctx: Ctx) => Promise<CallToolResult> | CallToolResult;
}

/** Declares a tool. The handler's args are typed from inputSchema. */
export const defineTool = <S extends Shape>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

/**
 * Registers each tool whose tier is on in cfg. Calls run against ctx, with unknown arguments, scopes and errors handled
 * here; without a ctx the tools can only be listed.
 */
export function registerTools(server: McpServer, defs: readonly ToolDef[], cfg: ToolConfig, ctx?: Ctx): void {
  for (const def of defs) if (cfg.tiers.has(def.tier)) registerTool(server, def, cfg, ctx);
}

function registerTool(server: McpServer, config: ToolDef, cfg: ToolConfig, ctx?: Ctx): void {
  const { name } = config;
  const scope = TIER_SCOPE[config.tier];
  const known = new Set([...Object.keys(config.inputSchema), 'intent']);
  const valid = Object.keys(config.inputSchema).join(', ') || '(none besides intent)';
  const writes = config.annotations.readOnlyHint !== true;
  server.registerTool(
    name,
    {
      title: config.title,
      description: typeof config.description === 'function' ? config.description(cfg) : config.description,
      // Loose, so unknown keys reach this wrapper instead of being stripped silently.
      inputSchema: z.looseObject({
        ...config.inputSchema,
        intent: CHATGPT_CONTRACT.has(name) ? zIntentOptional : zIntent,
      }),
      annotations: { title: config.title, ...config.annotations },
      ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
    },
    async (args: Record<string, unknown>) => {
      if (!ctx) throw new Error(`${name} was registered for listing only.`);
      const typed = args as Args<Shape>;
      const need = config.scopeFor?.(typed) ?? scope;
      if (!ctx.scopes.has(need))
        return insufficientScope(
          ctx,
          need,
          typeof config.scopeHint === 'function' ? config.scopeHint(typed, ctx) : config.scopeHint,
        );
      const unknown = Object.keys(args).filter((k) => !known.has(k));
      if (unknown.length && writes) {
        const plural = unknown.length > 1;
        const hints = unknown
          .map((k) => [k, suggestArg(k, known)] as const)
          .filter(([, s]) => s)
          .map(([k, s]) => `Use ${s} instead of ${k}. `)
          .join('');
        return errorResult(
          new ToolError(
            'unknown_argument',
            `${name} has no argument${plural ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}. Nothing was done.`,
            `${hints}Valid arguments: ${valid}.`,
          ),
        );
      }
      const rest: Record<string, unknown> = { ...args };
      delete rest.intent;
      for (const k of unknown) delete rest[k];
      let result: CallToolResult;
      try {
        result = await config.handler(rest as Args<Shape>, ctx);
      } catch (e) {
        if (e instanceof ToolError) result = errorResult(e);
        else {
          console.error(`[${name}]`, e);
          result = errorResult(
            new ToolError(
              'internal_error',
              'Something went wrong on the server.',
              writes
                ? 'It may or may not have taken effect. Check read_conversation or get_message before retrying; for send_message retry only with the same idempotency_key.'
                : 'Try again once; if it repeats, call get_status.',
            ),
          );
        }
      }
      // Read tools still answer, with a trailing note (never inside content[0], which may be JSON). search/fetch keep
      // ChatGPT's one-block shape.
      if (unknown.length && !CHATGPT_CONTRACT.has(name))
        result = {
          ...result,
          content: [
            ...result.content,
            { type: 'text', text: `Ignored unknown parameters: ${describeUnknown(unknown, known)}. Valid: ${valid}.` },
          ],
        };
      return result;
    },
  );
}

/**
 * The answer to a tools/call for a tool whose tier is turned off (the SDK would only say "not found"). undefined for
 * unknown names and enabled tiers.
 */
export function tierOffResult(cfg: ToolConfig, name: string | undefined): CallToolResult | undefined {
  const tier = name ? tierOf(name) : undefined;
  if (!tier || cfg.tiers.has(tier)) return undefined;
  if (tier === 'pa')
    return errorResult(
      new ToolError(
        PRIVATE_API_OFF.code,
        `${name} is turned off on this Mac (the Private API tier is not enabled).`,
        PRIVATE_API_OFF.fix,
      ),
    );
  return errorResult(
    new ToolError(
      'tool_not_enabled',
      `${name} is turned off on this Mac (the "${tier}" tier is not enabled).`,
      "Tell the user it can't be done from here; the owner controls this with TIERS in the bridge config.",
    ),
  );
}

/**
 * RFC 6750 allows only printable ASCII, minus the double quote and backslash, inside error_description; a quote would
 * end the value early, and strict parsers would then drop scope=, which ChatGPT needs to ask for consent again.
 */
const challengeValue = (s: string) => s.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, '');

/** ChatGPT shows its re-auth UI when a tool result carries this _meta challenge. */
function insufficientScope(ctx: Ctx, scope: string, hint?: string): CallToolResult {
  const label = SCOPE_INFO[scope]?.label ?? scope;
  const wanted = [...new Set([...ctx.scopes, scope])].filter((s) => ALL_SCOPES.includes(s)).join(' ');
  const desc = `This needs the "${label}" permission (${scope}), which this connection was not granted`;
  const challenge = [
    `resource_metadata="${challengeValue(ctx.resourceMetadataUrl)}"`,
    'error="insufficient_scope"',
    `error_description="${challengeValue(`This needs the ${label} permission (${scope}), which this connection was not granted`)}"`,
    `scope="${wanted}"`,
  ];
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Error insufficient_scope: ${desc}.\nFix: Ask the user to reconnect and allow "${label}".${hint ? ` ${hint}` : ''}`,
      },
    ],
    _meta: {
      'mcp/www_authenticate': `Bearer ${challenge.join(', ')}`,
    },
  };
}
