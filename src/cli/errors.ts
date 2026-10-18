/** The CLI's exit codes; `imessage --help` documents them. */
export const EXIT = { ok: 0, error: 1, timeout: 2, needsConfirmation: 3, ambiguous: 4, offline: 5, usage: 64 } as const;

/** Ends the command with this message on stderr and this exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number,
  ) {
    super(message);
  }
}
