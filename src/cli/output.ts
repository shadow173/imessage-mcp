// Printing a tool result: text or JSON on stdout, errors on stderr with a matching exit code, previews saved as files.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Parsed } from './args.js';
import { EXIT } from './errors.js';
import type { ToolResult } from './transport.js';

/** The exit code for an error result, from its "Error <code>:" line. */
export function failExit(text: string): number {
  const code = text.match(/^Error (\w+)/)?.[1] ?? '';
  if (code === 'confirmation_required') return EXIT.needsConfirmation;
  if (code === 'ambiguous_person' || code === 'ambiguous_chat' || code === 'exact_chat_required') return EXIT.ambiguous;
  if (code === 'mac_offline') return EXIT.offline;
  return EXIT.error;
}

export async function show(r: ToolResult, p: Parsed): Promise<number> {
  if (r.isError) {
    process.stderr.write(`${r.text}\n`);
    return failExit(r.text);
  }
  if (p.flags.json && r.structured !== undefined) process.stdout.write(`${JSON.stringify(r.structured, null, 2)}\n`);
  else if (r.text) process.stdout.write(`${r.text}\n`);
  for (const [i, img] of r.images.entries()) {
    const ext = img.mimeType.includes('png') ? 'png' : 'jpg';
    const file = join(tmpdir(), `imessage-preview-${Date.now()}-${i}.${ext}`);
    writeFileSync(file, Buffer.from(img.data, 'base64'));
    process.stdout.write(`Saved preview: ${file}\n`);
  }
  return EXIT.ok;
}
