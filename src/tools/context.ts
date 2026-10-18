import type { ToolConfig } from '../config.js';
import type { JournalSink } from '../lib/journal.js';
import type { MessageStore } from '../store/ports.js';

/** What every tool call runs against: the store, the config and who is asking. */
export interface Ctx {
  store: MessageStore;
  cfg: ToolConfig;
  /** Public origin, e.g. https://<your-gateway>.example */
  baseUrl: string;
  /** Send timestamps for rate limiting, shared across requests. */
  sendLog: number[];
  /** Scopes granted to the caller's access token. */
  scopes: Set<string>;
  /** For the insufficient-scope challenge. */
  resourceMetadataUrl: string;
  /** Who is calling (chatgpt, claude, claude-code, local-cli, ...), for the journal. */
  client?: string;
  /** Where tool calls and their intents are saved. Only the Mac bridge sets it. */
  journal?: JournalSink;
}
