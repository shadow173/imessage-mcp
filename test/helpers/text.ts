import assert from 'node:assert/strict';

/**
 * Reads the block get_attachment and fetch wrap around a file's own text: the label line, a begin line with a
 * per-response tag, the text, and an end line with the same tag. Asserts that framing and returns the text inside.
 */
export function attachmentText(out: string, label: string): string {
  const re = new RegExp(
    `${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\n--- begin attachment text ([0-9a-f]{8}): [^\\n]* ---\\n([\\s\\S]*?)\\n--- end attachment text ([0-9a-f]{8}) ---`,
  );
  const m = re.exec(out);
  assert.ok(m, `no "${label}" block in:\n${out}`);
  assert.equal(m[3], m[1], 'the end line carries the begin line tag');
  return m[2];
}
