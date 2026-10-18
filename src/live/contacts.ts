import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeAddress } from '../lib/address.js';

export interface ContactCard {
  key: string;
  name: string | null;
  nicknames: string[];
  company?: string;
  handles: Set<string>;
  isMe: boolean;
}

export interface ContactBook {
  cards: ContactCard[];
  byHandle: Map<string, ContactCard>;
  /** Handles listed on two or more unlinked cards; matched to the first card found. */
  ambiguous: Set<string>;
  meHandles: string[];
  meName: string | null;
}

/** Normalizes a chat.db handle or a Contacts value the same way so they match. */
export function handleKey(raw: string): string {
  return normalizeAddress(raw) ?? raw.trim().toLowerCase();
}

function addressBookFiles(dir: string): string[] {
  const out: string[] = [];
  const root = join(dir, 'AddressBook-v22.abcddb');
  if (existsSync(root)) out.push(root);
  const sources = join(dir, 'Sources');
  if (existsSync(sources))
    for (const s of readdirSync(sources)) {
      const f = join(sources, s, 'AddressBook-v22.abcddb');
      if (existsSync(f)) out.push(f);
    }
  return out;
}

type Row = Record<string, string | number | null>;

/** Reads every AddressBook database read-only. Works headless under Full Disk Access; no Contacts prompt. */
export function loadContacts(dir: string): ContactBook {
  const byLink = new Map<string, ContactCard>();
  const cards: ContactCard[] = [];
  for (const file of addressBookFiles(dir)) {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const recs = db
        .prepare(`select Z_PK pk, ZUNIQUEID uid, ZFIRSTNAME fn, ZMIDDLENAME mn, ZLASTNAME ln, ZNICKNAME nn, ZORGANIZATION org, ZLINKID link, ZCONTAINERWHERECONTACTISME me
        from ZABCDRECORD where coalesce(ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME) is not null`)
        .all() as Row[];
      const local = new Map<number, ContactCard>();
      for (const r of recs) {
        const person = [r.fn, r.ln].filter(Boolean).join(' ').trim();
        const name = person || (r.org ? String(r.org) : r.nn ? String(r.nn) : null);
        const linkKey = r.link ? `link:${r.link}` : `${file}:${r.uid ?? r.pk}`;
        let card = byLink.get(linkKey);
        if (!card) {
          card = {
            key: String(r.uid ?? `${file}:${r.pk}`),
            name,
            nicknames: [],
            company: r.org && person ? String(r.org) : undefined,
            handles: new Set(),
            isMe: r.me != null,
          };
          byLink.set(linkKey, card);
          cards.push(card);
        } else {
          card.name ??= name;
          if (r.me != null) card.isMe = true;
        }
        if (r.nn && !card.nicknames.includes(String(r.nn))) card.nicknames.push(String(r.nn));
        local.set(Number(r.pk), card);
      }
      for (const r of db
        .prepare('select ZOWNER owner, ZFULLNUMBER v from ZABCDPHONENUMBER where ZFULLNUMBER is not null')
        .all() as Row[])
        local.get(Number(r.owner))?.handles.add(handleKey(String(r.v)));
      for (const r of db
        .prepare(
          'select ZOWNER owner, coalesce(ZADDRESSNORMALIZED, ZADDRESS) v from ZABCDEMAILADDRESS where coalesce(ZADDRESSNORMALIZED, ZADDRESS) is not null',
        )
        .all() as Row[])
        local.get(Number(r.owner))?.handles.add(handleKey(String(r.v)));
    } finally {
      db.close();
    }
  }
  const byHandle = new Map<string, ContactCard>();
  const ambiguous = new Set<string>();
  const meHandles: string[] = [];
  let meName: string | null = null;
  for (const c of cards) {
    if (c.isMe) {
      meHandles.push(...c.handles);
      meName ??= c.name;
      continue;
    }
    for (const h of c.handles) {
      const prior = byHandle.get(h);
      if (prior && prior !== c) ambiguous.add(h);
      else byHandle.set(h, c);
    }
  }
  return { cards: cards.filter((c) => !c.isMe), byHandle, ambiguous, meHandles, meName };
}
