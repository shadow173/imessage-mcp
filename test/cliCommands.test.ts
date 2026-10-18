// The CLI's command table against the tools it calls: renaming a tool or one of its arguments fails here instead of
// silently breaking a command.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { Parsed } from '../src/cli/args.js';
import type { ToolCommand } from '../src/cli/command.js';
import { COMMANDS } from '../src/cli/commands/index.js';
import { CliError } from '../src/cli/errors.js';
import { ALL_TOOLS } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'imsg-cli-cmds-'));
const image = join(dir, 'icon.png');
writeFileSync(image, Buffer.from('not really a png'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Every flag set: as a bare switch, or with a value. */
const allFlags = (value: string | true): Parsed['flags'] =>
  new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? value : undefined) });
const parsed = (pos: string[], value: string | true): Parsed => ({
  pos,
  flags: allFlags(value),
  multi: { forward: ['a1'] },
});

/** Positionals that reach every branch of a command (group actions, label and remind with and without a chat). */
const POSITIONALS: Record<string, string[][]> = {
  group: [
    ['create', 'p1', 'p2'],
    ['rename', 'Chat', 'New name'],
    ['add', 'Chat', 'Sam'],
    ['remove', 'Chat', 'Sam'],
    ['icon', 'Chat', image],
    ['leave', 'Chat'],
  ],
  label: [[], ['Chat', 'work']],
  remind: [[], ['Chat', 'tomorrow', '09:00']],
};
const DEFAULT_POS = [['first', 'second', 'third']];

const toolCommands = Object.entries(COMMANDS).filter((e): e is [string, ToolCommand] => 'tool' in e[1]);

describe('CLI commands', () => {
  it('map onto tools that exist', () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    assert.ok(toolCommands.length > 25);
    for (const [name, cmd] of toolCommands) assert.ok(names.has(cmd.tool), `${name} calls unknown tool ${cmd.tool}`);
  });

  it('pass only arguments their tool accepts', () => {
    for (const [name, cmd] of toolCommands) {
      const def = ALL_TOOLS.find((t) => t.name === cmd.tool)!;
      const accepted = new Set([...Object.keys(def.inputSchema), 'intent']);
      let built = 0;
      for (const pos of POSITIONALS[name] ?? DEFAULT_POS)
        for (const value of [true, '2'] as const) {
          let args: Record<string, unknown>;
          try {
            args = cmd.build(parsed(pos, value));
          } catch (e) {
            // A usage error for this combination (e.g. react --remove with a value): nothing reaches the tool.
            if (e instanceof CliError) continue;
            throw e;
          }
          built++;
          for (const [k, v] of Object.entries(args))
            if (v !== undefined)
              assert.ok(accepted.has(k), `imessage ${name} passes "${k}", which ${cmd.tool} doesn't take`);
        }
      assert.ok(built > 0, `imessage ${name} never built its arguments`);
    }
  });
});
