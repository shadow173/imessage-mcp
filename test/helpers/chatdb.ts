import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadBridgeConfig } from '../../src/config.js';
import { TZ } from './mock.js';

const SCHEMA = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

/** 2001-01-01, the epoch of chat.db's dates. */
export const APPLE_EPOCH_MS = 978307200000;
/** A chat.db date: nanoseconds since 2001-01-01, from epoch ms (fractions of a ms are dropped). */
export const appleNs = (ms: number) => BigInt(Math.floor(ms) - APPLE_EPOCH_MS) * 1_000_000n;

/** Creates an empty chat.db with Messages' schema at path and returns it open. Close it before the store reads it. */
export function createChatDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA('chatdb-schema.sql'));
  return db;
}

export interface Contact {
  first: string;
  last?: string;
  nickname?: string;
  phones?: string[];
  emails?: string[];
}

/** Writes a Contacts database with these people under dir/AddressBook and returns that directory. */
export function createAddressBook(dir: string, contacts: Contact[]): string {
  const ab = join(dir, 'AddressBook');
  mkdirSync(ab, { recursive: true });
  const db = new DatabaseSync(join(ab, 'AddressBook-v22.abcddb'));
  db.exec(SCHEMA('addressbook-schema.sql'));
  const rec = db.prepare(
    'insert into ZABCDRECORD (Z_PK, Z_ENT, ZUNIQUEID, ZFIRSTNAME, ZLASTNAME, ZNICKNAME) values (?, 22, ?, ?, ?, ?)',
  );
  const phone = db.prepare('insert into ZABCDPHONENUMBER (Z_ENT, ZOWNER, ZFULLNUMBER) values (1, ?, ?)');
  const email = db.prepare(
    'insert into ZABCDEMAILADDRESS (Z_ENT, ZOWNER, ZADDRESS, ZADDRESSNORMALIZED) values (1, ?, ?, ?)',
  );
  contacts.forEach((c, i) => {
    const pk = i + 1;
    rec.run(pk, `u-${pk}`, c.first, c.last ?? null, c.nickname ?? null);
    for (const p of c.phones ?? []) phone.run(pk, p);
    for (const e of c.emails ?? []) email.run(pk, e, e.toLowerCase());
  });
  db.close();
  return ab;
}

/** Bridge config for a fixture under dir: every path inside it, the test time zone, and env on top. */
export function fixtureBridgeConfig(dir: string, env: Record<string, string> = {}) {
  return loadBridgeConfig({
    HOME: dir,
    CHAT_DB: join(dir, 'chat.db'),
    ADDRESSBOOK_DIR: join(dir, 'AddressBook'),
    DATA_DIR: join(dir, 'data'),
    ATTACHMENT_STAGE_DIR: join(dir, 'stage'),
    OWNER_TZ: TZ,
    LINK_SECRET: 'fixture-link-secret-0123456789abcdef',
    ...env,
  } as NodeJS.ProcessEnv);
}
