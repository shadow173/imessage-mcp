/** Runs fn with console.warn and console.error captured instead of printed; returns its result and the lines. */
export async function captureConsole<T>(fn: () => T | Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const { warn, error } = console;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  console.error = console.warn;
  try {
    return { result: await fn(), lines };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}
