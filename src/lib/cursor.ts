import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { ToolError } from './errors.js';

// Cursors are base64url JSON that the agent hands back, so they are untrusted input: each tool decodes its cursor with
// a zod schema, and nothing from a cursor reaches a store unchecked.

/** A page offset. The cap keeps a forged cursor from asking the store for an absurd OFFSET. */
export const zOffset = z.number().int().min(0).max(1_000_000);
/** An epoch-ms timestamp. */
export const zEpochMs = z.number().finite();
/** cursorHash output (10 characters). */
const zHash = z.string().regex(/^[\w-]{1,16}$/);

/** The offset-cursor fields shared by search_messages, list_conversations, list_attachments and list_links. */
export const offsetCursor = <K extends string>(kind: K) =>
  z.object({
    /** Which tool minted it. */
    k: z.literal(kind),
    /** Next offset. */
    o: zOffset,
    /** cursorHash of the query and filters, so the cursor can't be reused with different ones. */
    h: zHash.optional(),
    /** store.now() at the first page; later pages stop there, so new messages don't shift the offsets. */
    as_of: zEpochMs.optional(),
  });
export type OffsetCursor = z.infer<ReturnType<typeof offsetCursor>>;

const DEFAULT_FIX = 'Pass the cursor exactly as the same tool returned it, or omit it to start over.';

export function encodeCursor(obj: Record<string, unknown>): string {
  return 'c_' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * Parses a cursor with the tool's schema, whose k literal also checks the kind. fix: the per-tool recovery advice for
 * a malformed cursor (get_updates can't "omit it").
 */
export function decodeCursor<S extends z.ZodType<{ k: string }>>(
  cursor: string,
  schema: S,
  fix = DEFAULT_FIX,
): z.output<S> {
  const t = cursor.trim().toLowerCase();
  if (t === 'null' || t === 'undefined' || t === 'none') {
    throw new ToolError(
      'no_more_pages',
      'There are no more pages: a null next_cursor means the previous call returned the last page.',
      'Stop paging. To re-read the first page, omit cursor.',
    );
  }
  let raw: unknown;
  try {
    if (cursor.startsWith('c_')) raw = JSON.parse(Buffer.from(cursor.slice(2), 'base64url').toString('utf8'));
  } catch {
    /* not JSON: the schema rejects undefined */
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ToolError('invalid_cursor', 'That cursor is not valid for this tool.', fix);
  return parsed.data;
}

/** Key-sorted, undefined-free JSON, so the same filter always hashes the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stable(x))).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Short fingerprint of the query and filters a cursor belongs to. Leave out cursor, limit and format. */
export function cursorHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(stable(args)).digest('base64url').slice(0, 10);
}

/** Cursors minted before hashing (no h) stay valid; their offset is still schema-checked. */
export function checkCursorHash(c: { h?: string }, h: string): void {
  if (c.h !== undefined && c.h !== h) {
    throw new ToolError(
      'invalid_cursor',
      'That cursor came from a different query or filters.',
      'Repeat the same query and filters with the cursor (only limit and format may change), or omit it to start over.',
    );
  }
}
