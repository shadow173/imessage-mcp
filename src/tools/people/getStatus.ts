import type { Tier, ToolConfig } from '../../config.js';
import { PRIVATE_API_OFF } from '../../lib/errors.js';
import { fmtIso, fmtLong } from '../../lib/time.js';
import { CODE_MARKER } from '../../policy/redact.js';
import { GATED_TOOLS } from '../../policy/sendPolicy.js';
import { TOOL_CATALOG } from '../catalog.js';
import { defineTool, READ_ONLY } from '../registry.js';
import { jsonResult } from '../results.js';
import { peopleKit } from './common.js';

/** Tiers this server has turned off, with the tools they would add. Empty when everything is on. */
function unavailableTiers(cfg: ToolConfig) {
  const off = new Map<Tier, string[]>();
  for (const [name, tier] of TOOL_CATALOG) if (!cfg.tiers.has(tier)) off.set(tier, [...(off.get(tier) ?? []), name]);
  return [...off].map(([tier, tools]) => ({
    tier,
    tools,
    ...(tier === 'pa' && cfg.tiers.has('send') ? { send_message_params: ['reply_to', 'effect'] } : {}),
    why:
      tier === 'pa'
        ? 'The Private API tier is not enabled on this Mac.'
        : `The "${tier}" tier is not enabled on this Mac.`,
    fix:
      tier === 'pa'
        ? PRIVATE_API_OFF.fix
        : "Tell the user it can't be done from here; the owner controls this with TIERS in the bridge config.",
  }));
}

export const getStatus = defineTool({
  name: 'get_status',
  tier: 'read',
  title: 'Status',
  description: [
    'Who "me" is, the owner\'s current local time and time zone, which tool tiers are enabled (and what a missing tier would add), which scopes this connection was granted (a tool outside them fails with insufficient_scope), whether sending is on and which tools that switch covers, the send allowlist, whether verification codes are hidden, and health: permissions, whether Messages is running, the Private API and index freshness.',
    'Call it before offering to send, or when a tool reports a permission, scope or index error.',
  ].join(' '),
  inputSchema: {},
  annotations: READ_ONLY,
  handler: (_, ctx) => {
    const { store, cfg, tz } = peopleKit(ctx);
    const me = store.me();
    const now = store.now();
    const unavailable = unavailableTiers(cfg);
    return jsonResult({
      mode: store.mode,
      ...(store.mode === 'mock'
        ? {
            mock_notes: [
              'All people and messages are fake and reset on every restart or deploy.',
              'Sends go nowhere. Named contacts auto-reply 15–30 s after you message them, and your iMessage DMs get read receipts.',
              'Sending to any number ending in 0000 fails, to test failure handling.',
              cfg.redactCodes
                ? `One-time codes show as ${CODE_MARKER}: every code-shaped number from short codes (years and local phone numbers excepted when no code word is near), and numbers near words like code, verification, PIN, "to confirm" or "do not share" from anyone, including you.`
                : 'Verification-code hiding is off (REDACT_CODES=false), so codes are shown.',
            ],
          }
        : {}),
      me: { name: me.name, handles: me.handles },
      now: fmtIso(now, tz),
      now_local: fmtLong(now, tz),
      time_zone: tz,
      tiers: [...cfg.tiers],
      ...(unavailable.length ? { unavailable } : {}),
      private_api: cfg.tiers.has('pa')
        ? 'on'
        : 'off: reactions, edits, unsends, read marks, typing, inline replies, effects and group changes are unavailable. The owner turns them on with PRIVATE_API=imsg in bridge.env.',
      granted_scopes: [...ctx.scopes].sort(),
      send_policy: {
        send_enabled: cfg.sendEnabled,
        gated_tools: GATED_TOOLS,
        allowlist: cfg.sendAllowlist.mode === 'list' ? cfg.sendAllowlist.entries : cfg.sendAllowlist.mode,
        rate_limit_per_hour: cfg.sendRateLimitPerHour,
        redact_verification_codes: cfg.redactCodes,
      },
      redact_verification_codes: cfg.redactCodes,
      privacy: { verification_codes: cfg.redactCodes ? 'hidden' : 'shown', marker: CODE_MARKER },
      health: store.health ? store.health() : { mode: 'mock', private_api: cfg.tiers.has('pa') ? 'ready' : 'off' },
      counts: (() => {
        const c = store.counts();
        return { people: c.people, conversations: c.chats, messages: c.messages };
      })(),
    });
  },
});
