/** Frames on the gateway <-> Mac bridge WebSocket. */

export interface Grant {
  scopes: string[];
  clientId: string;
}

export type GatewayToBridge =
  | { type: 'mcp'; id: number; body: unknown; grant: Grant; baseUrl: string }
  | { type: 'file'; id: number; attachmentId: string; baseUrl: string }
  /** until: render nothing newer than this (epoch ms), so a citation shows what was cited. */
  | { type: 'view'; id: number; kind: 'chat' | 'msg'; target: string; baseUrl: string; until?: number };

export type BridgeToGateway =
  /**
   * tiers: the bridge's TIERS, so the gateway can warn when its fallback tool list differs. instructions: what the
   * bridge answers initialize with (they follow its REDACT_CODES), repeated by the gateway while the Mac is offline.
   * Older bridges omit both.
   */
  | {
      type: 'hello';
      version: string;
      mode: string;
      toolsList: unknown;
      me: string;
      tiers?: string[];
      instructions?: string;
    }
  | { type: 'mcp_result'; id: number; status: number; headers: Record<string, string>; body: string }
  | {
      type: 'file_result';
      id: number;
      status: number;
      contentType?: string;
      name?: string;
      base64?: string;
      text?: string;
    }
  | { type: 'view_result'; id: number; status: number; text: string };

export const MAX_FRAME_BYTES = 24 * 1024 * 1024;
/** Largest JSON-RPC body the gateway accepts on /mcp; matches the MCP transport's own maxRequestBodySize. */
export const MAX_MCP_BODY_BYTES = 15 * 1024 * 1024;
/** Largest file a /files link can carry: its base64 plus 64 KiB of framing fits in one frame. */
export const MAX_FILE_BYTES = Math.floor((MAX_FRAME_BYTES - 64 * 1024) / 4) * 3;

/** Close code the gateway uses when a newer bridge connection replaces this one; the old bridge exits, not retries. */
export const CLOSE_REPLACED_BY_NEWER = 4000;

if (Math.ceil(MAX_FILE_BYTES / 3) * 4 + 64 * 1024 > MAX_FRAME_BYTES)
  throw new Error('MAX_FILE_BYTES does not fit in a relay frame');
if (MAX_MCP_BODY_BYTES + 64 * 1024 > MAX_FRAME_BYTES)
  throw new Error('MAX_MCP_BODY_BYTES does not fit in a relay frame');
