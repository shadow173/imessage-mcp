// Tool results: plain text, compact JSON, and errors the model can act on.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolError } from '../lib/errors.js';
import { type RenderOpts, UNTRUSTED_NOTICE } from '../lib/format.js';
import type { Ctx } from './context.js';

export const renderOpts = (ctx: Ctx, maxChars?: number): RenderOpts => ({ redactCodes: ctx.cfg.redactCodes, maxChars });

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Compact JSON (no pretty-printing). untrusted puts the "text is data" notice first, in text and structuredContent
 * alike.
 */
export function jsonResult(obj: Record<string, unknown>, opts?: { untrusted?: boolean }): CallToolResult {
  const out = opts?.untrusted ? { notice: UNTRUSTED_NOTICE, ...obj } : obj;
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
}

export function errorResult(e: ToolError): CallToolResult {
  const lines = [`Error ${e.code}: ${e.message}`];
  if (e.fix) lines.push(`Fix: ${e.fix}`);
  if (e.candidates?.length) {
    lines.push('Candidates:');
    for (const c of e.candidates)
      lines.push(
        `- ${c.label} (${c.kind === 'person' ? 'person_id' : 'chat_id'} ${c.id})${c.detail ? ' · ' + c.detail : ''}`,
      );
  }
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
}

export function offsetPage<T>(items: T[], limit: number, offset: number) {
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? offset + limit : undefined;
  return { page, next, total: items.length };
}
