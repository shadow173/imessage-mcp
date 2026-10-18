// Runs a multi-step "journey" against the MOCK store (seeded fake data) through the real MCP tool surface.
// Touches no real data.
// Usage:
//   npx tsx scripts/dev/journey.ts --describe [journey.json]  # server instructions + every tool as an agent sees
//                                                             # it, with that journey's options
//   npx tsx scripts/dev/journey.ts path/to/journey.json       # run steps; or pipe JSON on stdin
// Journey JSON: { "options": {...}, "steps": [ { "tool": "find", "args": { "query": "Sam" } }, ... ] }
// Chain steps with placeholders inside string args:
//   {{steps.0.structuredContent.hits.0.message_id}}   a path into an earlier step's result
//   {{steps.0.regex:#(m\d+)}}                          first capture group from an earlier step's text
// options: scopes (string[]), sendEnabled (bool), tiers (string), sendAllowlist (string), redactCodes (bool),
//          autoReply (bool), rateLimit (number per hour)
// Times print in OWNER_TZ (default UTC, so a journey reads the same on every machine).

import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_SCOPES } from '../../src/auth/scopes.js';
import { loadToolConfig } from '../../src/config.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.js';
import { MockStore } from '../../src/mock/mockStore.js';
import { buildServer } from '../../src/server.js';
import { tierOffResult } from '../../src/tools/registry.js';

type Step = { tool: string; args?: Record<string, unknown> };
type Journey = {
  options?: {
    scopes?: string[];
    sendEnabled?: boolean;
    tiers?: string;
    sendAllowlist?: string;
    redactCodes?: boolean;
    autoReply?: boolean;
    rateLimit?: number;
  };
  steps: Step[];
};

const arg = process.argv[2];
const TZ = process.env.OWNER_TZ || 'UTC';
const cfgFor = (opts: NonNullable<Journey['options']>) =>
  loadToolConfig(
    {
      SEND_ENABLED: opts.sendEnabled === false ? 'false' : 'true',
      REDACT_CODES: opts.redactCodes === false ? 'false' : 'true',
      ...(opts.tiers ? { TIERS: opts.tiers } : {}),
      ...(opts.sendAllowlist ? { SEND_ALLOWLIST: opts.sendAllowlist } : {}),
      ...(opts.rateLimit !== undefined ? { SEND_RATE_LIMIT_PER_HOUR: String(opts.rateLimit) } : {}),
    } as NodeJS.ProcessEnv,
    { timeZone: TZ, linkSecret: 'journey-link-secret-0123456789abcdef', tiers: 'read,send,org,pa,gpt' },
  );

async function connect(opts: NonNullable<Journey['options']>) {
  // redactCodes also goes to the store: the search index hides codes at index time.
  const store = new MockStore({
    timeZone: TZ,
    autoReply: opts.autoReply ?? false,
    redactCodes: opts.redactCodes !== false,
  });
  const server = buildServer({
    store,
    cfg: cfgFor(opts),
    baseUrl: 'https://imessage.example',
    sendLog: [],
    scopes: new Set(opts.scopes ?? ALL_SCOPES),
    resourceMetadataUrl: 'https://imessage.example/.well-known/oauth-protected-resource/mcp',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'journey', version: '1' });
  await client.connect(b);
  return client;
}

/** Lets journey output finish reaching a pipe before exiting (on macOS a piped stdout is async). */
const exit = (code: number) => process.stdout.write('', () => process.exit(code));

type Prop = {
  description?: string;
  type?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: Prop;
  anyOf?: Prop[];
};
const typeOf = (v: Prop): string => {
  if (v.enum) return v.enum.join('|');
  if (v.type === 'array') return `${v.items ? typeOf(v.items) : 'any'}[]`;
  if (v.anyOf) return v.anyOf.map(typeOf).join(' or ');
  return v.type ?? 'any';
};
const bounds = (v: Prop) =>
  [
    v.minimum !== undefined ? `min ${v.minimum}` : '',
    v.maximum !== undefined ? `max ${v.maximum}` : '',
    v.minItems !== undefined ? `min ${v.minItems} items` : '',
    v.maxItems !== undefined ? `max ${v.maxItems} items` : '',
  ]
    .filter(Boolean)
    .join(', ');

if (arg === '--describe') {
  const opts = process.argv[3] ? ((JSON.parse(readFileSync(process.argv[3], 'utf8')) as Journey).options ?? {}) : {};
  const c = await connect(opts);
  const { tools } = await c.listTools();
  console.log(
    `SERVER INSTRUCTIONS\n${SERVER_INSTRUCTIONS}\n\n${tools.length} TOOLS${Object.keys(opts).length ? ` (options ${JSON.stringify(opts)})` : ''}\n`,
  );
  for (const t of tools) {
    const props = (t.inputSchema as { properties?: Record<string, Prop> }).properties ?? {};
    const req = new Set((t.inputSchema as { required?: string[] }).required ?? []);
    console.log(
      `TOOL ${t.name}  [${Object.entries(t.annotations ?? {})
        .filter(([k, v]) => k.endsWith('Hint') && v === true)
        .map(([k]) => k)
        .join(', ')}]\n  ${t.description}`,
    );
    for (const [k, v] of Object.entries(props))
      console.log(
        `   - ${k}${req.has(k) ? ' (required)' : ''}: ${typeOf(v)}${bounds(v) ? ` (${bounds(v)})` : ''}${v.default !== undefined ? ` = ${JSON.stringify(v.default)}` : ''}${v.description ? ` — ${v.description}` : ''}`,
      );
    console.log('');
  }
  exit(0);
} else {
  const raw = arg ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');
  const journey = JSON.parse(raw) as Journey;
  const cfg = cfgFor(journey.options ?? {});
  const c = await connect(journey.options ?? {});
  /** Steps get a default intent; a step can set "intent" itself, or "intent": null to test the missing-intent error. */
  const withIntent = (args: Record<string, unknown>) => {
    if (!('intent' in args)) return { ...args, intent: 'journey test of an agent workflow on mock data' };
    if (args.intent === null) {
      const { intent: _i, ...rest } = args;
      return rest;
    }
    return args;
  };
  const results: { text: string; structuredContent?: unknown; isError?: boolean; _meta?: unknown }[] = [];

  function resolve(v: unknown): unknown {
    if (typeof v === 'string') {
      return v.replace(/\{\{steps\.(\d+)\.(.+?)\}\}/g, (_m, i: string, path: string) => {
        const r = results[Number(i)];
        if (!r) return `<<missing step ${i}>>`;
        if (path.startsWith('regex:')) {
          const m = r.text.match(new RegExp(path.slice(6)));
          return m?.[1] ?? `<<no match for ${path.slice(6)}>>`;
        }
        let cur: any = r;
        for (const key of path.split('.')) cur = cur?.[key];
        return cur === undefined ? `<<undefined ${path}>>` : String(cur);
      });
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  }

  for (const [i, step] of journey.steps.entries()) {
    const args = resolve(step.args ?? {}) as Record<string, unknown>;
    const s = Date.now();
    let r: any;
    // Journeys skip handleMcp, so answer a turned-off tier here the way the server would.
    try {
      r = tierOffResult(cfg, step.tool) ?? (await c.callTool({ name: step.tool, arguments: withIntent(args) }));
    } catch (e) {
      r = {
        isError: true,
        content: [
          {
            type: 'text',
            text: `PROTOCOL ERROR (the MCP layer rejected the call before the tool ran): ${(e as Error).message}`,
          },
        ],
      };
    }
    const text = (r.content ?? [])
      .map((x: any) => (x.type === 'text' ? x.text : `[${x.type} content${x.mimeType ? ` ${x.mimeType}` : ''}]`))
      .join('\n');
    results.push({ text, structuredContent: r.structuredContent, isError: r.isError, _meta: r._meta });
    console.log(
      `━━━ step ${i} · ${step.tool} ${JSON.stringify(args)} · ${Date.now() - s} ms · ${text.length} chars${r.isError ? ' · isError' : ''}`,
    );
    console.log(text);
    if (r.structuredContent && !text.trim().startsWith('{'))
      console.log(`[structuredContent] ${JSON.stringify(r.structuredContent).slice(0, 1500)}`);
    if (r._meta) console.log(`[_meta] ${JSON.stringify(r._meta)}`);
    console.log('');
  }
  exit(0);
}
