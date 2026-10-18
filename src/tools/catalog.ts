import { TIER_SCOPE } from '../auth/scopes.js';
import type { Tier } from '../config.js';

/**
 * Every tool and its tier, in the order tools/list shows them. Tools are registered only when their tier is on; this
 * list also covers the ones that are off, so a call to one can say why. A test checks that it matches the tools the
 * server registers.
 */
export const TOOL_CATALOG: readonly (readonly [name: string, tier: Tier])[] = [
  ['find', 'read'],
  ['search_people', 'read'],
  ['search_messages', 'read'],
  ['list_conversations', 'read'],
  ['read_conversation', 'read'],
  ['get_conversation', 'read'],
  ['get_message', 'read'],
  ['get_reply_thread', 'read'],
  ['catch_up', 'read'],
  ['get_updates', 'read'],
  ['get_person', 'read'],
  ['get_stats', 'read'],
  ['get_status', 'read'],
  ['list_attachments', 'read'],
  ['get_attachment', 'read'],
  ['list_links', 'read'],
  ['send_message', 'send'],
  ['create_draft', 'send'],
  ['manage_drafts', 'send'],
  ['update_person', 'org'],
  ['label_conversation', 'org'],
  ['set_reminder', 'org'],
  ['react', 'pa'],
  ['edit_message', 'pa'],
  ['unsend_message', 'pa'],
  ['mark_read', 'pa'],
  ['set_typing', 'pa'],
  ['manage_group', 'pa'],
  ['search', 'gpt'],
  ['fetch', 'gpt'],
];

const TIERS_BY_NAME = new Map<string, Tier>(TOOL_CATALOG);

/** The tier a tool belongs to, whether or not that tier is on; undefined for an unknown name. */
export const tierOf = (name: string): Tier | undefined => TIERS_BY_NAME.get(name);

/** The OAuth scope a tool needs by default (a tool can ask for less for some arguments); undefined if unknown. */
export function scopeOf(name: string): string | undefined {
  const tier = tierOf(name);
  return tier && TIER_SCOPE[tier];
}
