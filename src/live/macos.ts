import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

/** AppleScript errors the bridge reacts to. */
export const OSA_NOT_AUTHORIZED = -1743; // the Automation permission for Messages is missing
export const OSA_NO_SUCH_OBJECT = -1728; // no such account, chat or participant
export const OSA_NOT_AUTHORIZED_RE = new RegExp(
  `${OSA_NOT_AUTHORIZED}|not authori[sz]ed|Not allowed to send Apple events`,
  'i',
);

/** The variables a child process may see. The bridge's secrets and anything else in its environment stay behind. */
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'DEVELOPER_DIR'];

/** A minimal environment for osascript, swiftc, textutil, sips, qlmanage and imsg, plus any extra variables. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

const execFileAsync = promisify(execFile);
/** Runs a command with childEnv(), so it never sees the bridge's secrets. */
export const execChild = (cmd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) =>
  execFileAsync(cmd, args, { ...opts, env: childEnv() });

const isExecutable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The absolute path a command name resolves to on PATH (or a given path, made absolute), if it is executable. */
export function resolveExecutable(cmd: string, path = process.env.PATH ?? ''): string | undefined {
  if (cmd.includes('/')) {
    const abs = isAbsolute(cmd) ? cmd : resolve(cmd);
    return isExecutable(abs) ? abs : undefined;
  }
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, cmd);
    if (isExecutable(file)) return file;
  }
  return undefined;
}
