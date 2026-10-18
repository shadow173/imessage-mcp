// Runs the MessageStore contract (store.contract.ts) against the mock store and the live store on a fixture chat.db.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LiveStore } from '../src/live/liveStore.js';
import { appleNs, createAddressBook, createChatDb, fixtureBridgeConfig } from './helpers/chatdb.js';
import { newMockStore } from './helpers/mock.js';
import { encodeAttributedBody as body } from './helpers/typedstream.js';
import { waitFor } from './helpers/wait.js';
import { type StoreHarness, storeContract } from './store.contract.js';

/** Each injected message lands at least a millisecond after anything before it (reminders compare times). */
const tick = () => new Promise((r) => setTimeout(r, 2));

storeContract('MockStore', async (): Promise<StoreHarness> => {
  const store = newMockStore();
  const dm = { chatId: 'iMessage;-;+15555550142', personId: 'p_sam_ortiz', name: 'Sam Ortiz' };
  let n = 0;
  return {
    store,
    dm,
    inbound: async (text) => {
      await tick();
      return store.receive(dm.chatId, dm.personId, text).messageId;
    },
    outbound: async (text) => {
      await tick();
      return (await store.send({ chatId: dm.chatId }, text, [], 'auto', `contract-${++n}`)).message!.messageId;
    },
    tapback: async (id) => {
      await store.react(id, 'like', undefined, false);
    },
    unknownName: 'p_nobody',
    close: () => {},
  };
});

storeContract('LiveStore', async (): Promise<StoreHarness> => {
  const dir = mkdtempSync(join(tmpdir(), 'imsg-contract-'));
  const chatDbPath = join(dir, 'chat.db');
  createAddressBook(dir, [{ first: 'Sam', last: 'Ortiz', phones: ['(555) 555-0142'] }]);
  const chatId = 'any;-;+15555550142';
  const setup = createChatDb(chatDbPath);
  setup.prepare("insert into handle (ROWID, id, service) values (1, '+15555550142', 'iMessage')").run();
  setup
    .prepare(
      "insert into chat (ROWID, guid, style, chat_identifier, service_name, display_name) values (1, ?, 45, '+15555550142', 'iMessage', null)",
    )
    .run(chatId);
  setup.prepare('insert into chat_handle_join (chat_id, handle_id) values (1, 1)').run();
  setup.close();
  let rowid = 0;
  /** Writes one row to chat.db the way Messages would; returns its message_id and guid. */
  const insert = (mine: boolean, text: string | null, o: { assocGuid?: string; assocType?: number } = {}) => {
    const db = new DatabaseSync(chatDbPath);
    try {
      rowid++;
      const at = Date.now();
      db.prepare(
        `insert into message (ROWID, guid, attributedBody, handle_id, is_from_me, service, date, is_read, associated_message_guid, associated_message_type, is_delivered)
         values (?, ?, ?, 1, ?, 'iMessage', ?, ?, ?, ?, 1)`,
      ).run(
        rowid,
        `G-${rowid}`,
        text === null ? null : body(text),
        mine ? 1 : 0,
        appleNs(at),
        mine ? 1 : 0,
        o.assocGuid ?? null,
        o.assocType ?? 0,
      );
      db.prepare('insert into chat_message_join (chat_id, message_id, message_date) values (1, ?, ?)').run(
        rowid,
        appleNs(at),
      );
      return { id: `m${rowid}`, guid: `G-${rowid}` };
    } finally {
      db.close();
    }
  };
  insert(false, 'an older message');
  // Sending through Messages is out of scope here: the fake sender writes the row Messages would.
  const store = new LiveStore(fixtureBridgeConfig(dir), {
    sender: (deps) => async (target) => {
      const { id } = insert(true, 'sent by the fake sender');
      deps.poll();
      return { disposition: 'delivered', chatId: target.chatId ?? chatId, message: deps.message(id), retrySafe: false };
    },
  });
  store.start();
  await waitFor(() => store.indexStatus().ready, 'the search index to build');
  const add = async (mine: boolean, text: string) => {
    await tick();
    const { id } = insert(mine, text);
    store.poll();
    return id;
  };
  const sam = store.people().find((p) => p.name === 'Sam Ortiz')!;
  return {
    store,
    dm: { chatId, personId: sam.personId, name: 'Sam Ortiz' },
    inbound: (text) => add(false, text),
    outbound: (text) => add(true, text),
    tapback: async (id) => {
      await tick();
      insert(true, null, { assocGuid: `p:0/G-${id.slice(1)}`, assocType: 2001 });
      store.poll();
    },
    unknownName: 'Unknown',
    close: () => {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
