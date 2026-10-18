// What the bridge answers to each frame the gateway relays: MCP calls, /files downloads and /view citation pages.

import { clientLabel } from '../lib/journal.js';
import { handleMcp } from '../mcpHandler.js';
import { type BridgeToGateway, type GatewayToBridge, MAX_FILE_BYTES, MAX_FRAME_BYTES } from '../relay/protocol.js';
import type { MessageStore } from '../store/ports.js';
import { chatTranscript, messageTranscript } from '../tools/chatgpt/transcripts.js';
import type { Ctx } from '../tools/context.js';

/** Builds the tool context for one request: the caller's scopes, the gateway origin for links, and the client label. */
export type CtxFor = (scopes: string[], baseUrl: string, client?: string) => Ctx;

/** Answers gateway frames against the store. */
export function createFrameHandler(store: MessageStore, ctxFor: CtxFor) {
  return async function handle(frame: GatewayToBridge): Promise<BridgeToGateway> {
    if (frame.type === 'mcp') {
      const r = await handleMcp(
        ctxFor(frame.grant.scopes, frame.baseUrl, clientLabel(frame.grant.clientId)),
        frame.body,
      );
      return { type: 'mcp_result', id: frame.id, ...r };
    }
    if (frame.type === 'file') {
      const f = await store.attachmentFile(frame.attachmentId);
      // 413 rather than a frame the gateway's socket would refuse (and drop the connection over).
      if (!f)
        return {
          type: 'file_result',
          id: frame.id,
          status: (store.attachment(frame.attachmentId)?.bytes ?? 0) > MAX_FILE_BYTES ? 413 : 404,
        };
      if (f.data.length > MAX_FILE_BYTES) return { type: 'file_result', id: frame.id, status: 413 };
      return {
        type: 'file_result',
        id: frame.id,
        status: 200,
        contentType: f.mime,
        name: f.name,
        base64: f.data.toString('base64'),
      };
    }
    const ctx = ctxFor([], frame.baseUrl);
    // A citation shows what fetch showed: the latest 50 messages, or 5 around the message, and nothing sent after the
    // link was made.
    if (frame.kind === 'chat')
      return store.chat(frame.target)
        ? {
            type: 'view_result',
            id: frame.id,
            status: 200,
            text: chatTranscript(ctx, store, frame.target, 50, frame.until),
          }
        : { type: 'view_result', id: frame.id, status: 404, text: '' };
    return store.message(frame.target)
      ? {
          type: 'view_result',
          id: frame.id,
          status: 200,
          text: messageTranscript(ctx, store, frame.target, 5, frame.until),
        }
      : { type: 'view_result', id: frame.id, status: 404, text: '' };
  };
}

/** Any reply too big for one frame is swapped for a small one the gateway can relay. */
export function fitFrame(frame: GatewayToBridge, reply: BridgeToGateway, maxBytes = MAX_FRAME_BYTES): string {
  const json = JSON.stringify(reply);
  if (Buffer.byteLength(json) <= maxBytes - 1024) return json;
  console.error(`reply to ${frame.type} request too large (${Buffer.byteLength(json)} bytes); sent 413 instead`);
  if (frame.type === 'file')
    return JSON.stringify({ type: 'file_result', id: frame.id, status: 413 } satisfies BridgeToGateway);
  if (frame.type === 'view')
    return JSON.stringify({ type: 'view_result', id: frame.id, status: 413, text: '' } satisfies BridgeToGateway);
  const ids = (Array.isArray(frame.body) ? frame.body : [frame.body])
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id) => id !== undefined && id !== null);
  const errors = (ids.length ? ids : [null]).map((id) => ({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32603,
      message:
        'Response too large for the gateway. Ask for less (a smaller limit or max_chars), or a preview instead of the full file.',
    },
  }));
  return JSON.stringify({
    type: 'mcp_result',
    id: frame.id,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Array.isArray(frame.body) ? errors : errors[0]),
  } satisfies BridgeToGateway);
}
