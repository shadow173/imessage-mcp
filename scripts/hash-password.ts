// Prints the scrypt hash to set as OWNER_PASSWORD_HASH on the gateway.
// Usage: npx tsx scripts/hash-password.ts                     asks twice; what you type isn't shown
//    or: read -s PW; printf %s "$PW" | npx tsx scripts/hash-password.ts
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { hashPassword } from '../src/auth/crypto.js';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Reads a line from the terminal without echoing it. readline writes its echo to `output`, which drops it. */
async function askHidden(prompts: string[]): Promise<string[]> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  rl.on('SIGINT', () => {
    process.stderr.write('\n');
    process.exit(130);
  });
  const answers: string[] = [];
  for (const prompt of prompts) {
    process.stderr.write(prompt);
    muted = true;
    answers.push(await rl.question(''));
    muted = false;
    process.stderr.write('\n');
  }
  rl.close();
  return answers;
}

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

let pw: string;
if (process.stdin.isTTY) {
  const [first, again] = await askHidden(['New password: ', 'Again: ']);
  if (first !== again) fail("The passwords don't match.");
  pw = first;
} else pw = await readPiped();
if (pw.length < 12) fail('Use at least 12 characters.');
console.log(hashPassword(pw));
