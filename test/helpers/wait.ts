/** Polls until cond() is true; throws after timeoutMs instead of hanging the suite. */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
