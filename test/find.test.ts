import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_SCOPES } from '../src/auth/scopes.js';
import { loadToolConfig } from '../src/config.js';
import { encodeCursor } from '../src/lib/cursor.js';
import { UNTRUSTED_NOTICE } from '../src/lib/format.js';
import { CODE_MARKER } from '../src/policy/redact.js';
import { buildServer } from '../src/server.js';
import type { Ctx } from '../src/tools/context.js';
import { type Result, text } from './helpers/mcp.js';
import { newMockStore } from './helpers/mock.js';

const TZ = 'America/New_York';

async function setup(env: Record<string, string> = {}) {
  const store = newMockStore();
  const cfg = loadToolConfig(env as NodeJS.ProcessEnv, {
    timeZone: TZ,
    linkSecret: 'find-test-link-secret-0123456789ab',
    tiers: 'read,send,org,pa,gpt',
  });
  const ctx: Ctx = {
    store,
    cfg,
    baseUrl: 'https://imessage.example',
    sendLog: [],
    scopes: new Set(ALL_SCOPES),
    resourceMetadataUrl: 'https://imessage.example/.well-known/oauth-protected-resource/mcp',
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx).connect(a);
  const client = new Client({ name: 'find-test', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: { intent: 'unit test of the find tools', ...args } })) as Result;
  return { store, client, call };
}
const all = (r: Result) => `${text(r)}\n${JSON.stringify(r.structuredContent ?? {})}`;
const CODES = /482913|105377|7731/;
/**
 * Lets the clock pass the first page's as_of, so a send between pages is strictly newer (the mock clock is Date.now()).
 */
const tick = () => new Promise((r) => setTimeout(r, 3));

describe('person summaries hide codes', () => {
  it('find, search_people and get_person never show a hidden code, in text or json', async () => {
    const { call } = await setup();
    for (const q of ['28734', '86753']) {
      for (const r of [
        await call('find', { query: q }),
        await call('find', { query: q, format: 'json' }),
        await call('search_people', { query: q }),
        await call('search_people', { query: q, format: 'json' }),
        await call('get_person', { person: q }),
      ]) {
        assert.doesNotMatch(all(r), CODES, q);
      }
    }
    const bank = (await call('find', { query: '28734', format: 'json' })).structuredContent.people[0];
    assert.ok(bank.last_interaction.snippet.includes(CODE_MARKER), bank.last_interaction.snippet);
    assert.ok(
      (
        await call('search_people', { query: '86753', format: 'json' })
      ).structuredContent.people[0].last_interaction.snippet.includes(CODE_MARKER),
    );
    await call('update_person', { person: '28734', add_aliases: ['my bank'] });
    const viaAlias = await call('find', { query: 'my bank' });
    assert.match(text(viaAlias), /28734/);
    assert.doesNotMatch(all(viaAlias), CODES);
  });

  it('snippets cut at a word boundary and never through a code marker; counts are pluralized', async () => {
    const { store, call } = await setup();
    const t = text(await call('find', { query: 'Sam Ortiz' }));
    const line = /last: Sam "([^"]+)…"/.exec(t)![1];
    const full = store.personActivity('p_sam_ortiz').last!.text;
    assert.ok(full.startsWith(line) && full[line.length] === ' ', `"${line}" ends mid-word in "${full}"`);
    assert.match(t, /1 shared group ·/);
    const bank = text(await call('find', { query: '28734' }));
    assert.doesNotMatch(bank, /\[verif[^\]]*…/);
    assert.match(bank, /0 shared groups · 2 messages/);
    const stranger = text(await call('search_people', { query: '0188' }));
    assert.match(stranger, /1 message ·/);
    assert.match(stranger, /last: \(555\) 555-0188 "/); // the full number, not "(555)"
  });
});

describe('person summaries', () => {
  it('split counts, your last message and needs_reply', async () => {
    const { call } = await setup();
    const t = text(await call('find', { query: 'Sam Lee' }));
    assert.match(t, /8 messages \(4 in 1:1 · 4 by them in groups\)/);
    assert.ok(
      t.includes(
        ' · last: Sam "also my friend has an extra ticket to the show…" Sat Oct 17 14:17 EDT · you: Sun Sep 27 21:30 EDT · needs reply',
      ),
      t,
    );
    const p = (await call('search_people', { query: 'Sam Lee', format: 'json' })).structuredContent.people[0];
    assert.equal(p.dm_message_count, 4);
    assert.equal(p.their_group_message_count, 4);
    assert.equal(p.needs_reply, true);
    assert.equal(p.last_from_you.chat_id, 'iMessage;-;+15555550177');
    assert.match(p.last_from_you.snippet, /see you Thursday/);
    const bank = (await call('search_people', { query: '28734', format: 'json' })).structuredContent.people[0];
    assert.equal(bank.last_from_you, null);
    assert.match(text(await call('search_people', { query: '28734' })), /you: never/);
  });

  it('notes and labels show up, and labels are searchable and excludable', async () => {
    const { store, call } = await setup();
    store.updatePerson('p_sam_lee', {
      note: 'met at the climbing gym, has a dog named Biscuit',
      addLabels: ['climbing'],
    });
    const t = text(await call('find', { query: 'Sam' }));
    assert.match(t, /Sam Lee \(note "met at the climbing gym, has a dog named Biscuit" · #climbing\)/);
    const byLabel = await call('search_people', { query: 'climbing', format: 'json' });
    assert.deepEqual(
      byLabel.structuredContent.people.map((x: any) => x.person_id),
      ['p_sam_lee'],
    );
    assert.equal(byLabel.structuredContent.people[0].note, 'met at the climbing gym, has a dog named Biscuit');
    assert.deepEqual(byLabel.structuredContent.people[0].labels, ['climbing']);
    const excluded = await call('search_people', { query: 'Sam -climbing', format: 'json' });
    assert.deepEqual(
      excluded.structuredContent.people.map((x: any) => x.person_id),
      ['p_sam_ortiz'],
    );
    assert.match(text(await call('find', { query: 'climbing' })), /Sam Lee/);
  });
});

describe('search_people', () => {
  it('matches phone and email fragments, and says plainly when a number is unused', async () => {
    const { call } = await setup();
    assert.equal(
      (await call('search_people', { query: '555-0142', format: 'json' })).structuredContent.people[0].person_id,
      'p_sam_ortiz',
    );
    assert.equal(
      (await call('search_people', { query: '5550142', format: 'json' })).structuredContent.people[0].person_id,
      'p_sam_ortiz',
    );
    assert.equal(
      (await call('search_people', { query: 'ortiz@example', format: 'json' })).structuredContent.people[0].person_id,
      'p_sam_ortiz',
    );
    assert.equal(
      text(await call('search_people', { query: '(555) 555-1234' })),
      'No contact or conversation uses (555) 555-1234.',
    );
    assert.doesNotMatch(text(await call('search_people', { query: 'nobody-by-this-name' })), /pass a phone/i);
  });

  it('puts the untrusted notice first when a result carries message text', async () => {
    const { call } = await setup();
    assert.ok(text(await call('search_people', { query: 'Sam' })).startsWith(UNTRUSTED_NOTICE));
    const j = await call('search_people', { query: 'Sam', format: 'json' });
    assert.equal(Object.keys(j.structuredContent)[0], 'notice');
    assert.ok(text(j).startsWith('{"notice"'));
  });

  it('search_people "-word" also excludes by note', async () => {
    const { call } = await setup();
    await call('update_person', { person: 'p_sam_lee', note: 'Met at the climbing gym' });
    const names = (
      await call('search_people', { query: 'Sam -climbing', format: 'json' })
    ).structuredContent.people.map((p: any) => p.person_id);
    assert.deepEqual(names, ['p_sam_ortiz']);
  });
});

describe('find', () => {
  it('describes itself as a broad lookup, not the first stop', async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    const find = tools.find((t) => t.name === 'find')!;
    assert.match(find.description!, /^Broad lookup across people, conversations and message text in one call\./);
    assert.match(find.description!, /If you already know the person or chat, call that tool directly\./);
    assert.doesNotMatch(find.description!, /Start here|literal|most recent/);
    const sm = tools.find((t) => t.name === 'search_messages')!;
    assert.doesNotMatch(sm.description!, /literal/);
    assert.match(sm.description!, /A word of 3\+ letters also matches as a prefix/);
    assert.match(sm.description!, /not text inside photos or PDFs/);
    assert.match(
      sm.description!,
      /For everything a person sent, in your 1:1 and in group chats, set from to that person/,
    );
    assert.match(sm.description!, /set chat to the person or use with=person, chat_type=dm/);
    const props = sm.inputSchema.properties as Record<string, any>;
    assert.match(props.on.description, /whole day/);
    assert.match(props.before.description, /exclusive/);
    assert.deepEqual(props.attachment_type.items.enum, [
      'image',
      'video',
      'audio',
      'voice_memo',
      'pdf',
      'document',
      'sticker',
    ]);
    const lc = tools.find((t) => t.name === 'list_conversations')!;
    assert.match(
      lc.description!,
      /participants_omitted counts the rest; get_conversation has everyone\) and participant_count includes you/,
    );
    assert.match(lc.description!, /needs_reply for chats waiting on your reply/);
    assert.match(
      (lc.inputSchema.properties as any).needs_reply.description,
      /groups, broadcasts and unknown senders sort last and are labelled/,
    );
    assert.match((lc.inputSchema.properties as any).query.description, /a label/);
  });

  it('lists 1:1 chats of matched people and ranks their messages first', async () => {
    const { call } = await setup();
    const dad = await call('find', { query: 'Dad', format: 'json' });
    assert.ok(dad.structuredContent.conversations.some((c: any) => c.chat_id === 'RCS;-;+15555550112'));
    const mom = await call('find', { query: 'Mom' });
    const t = text(mom);
    assert.ok(t.startsWith(UNTRUSTED_NOTICE));
    assert.equal(t.split(UNTRUSTED_NOTICE).length, 2, 'the notice appears once');
    assert.match(t, /Messages containing "Mom" \(/);
    assert.ok(t.indexOf('#m1645') < t.indexOf('#m1668'), "a message in Mom's chat ranks above the unknown sender's");
    assert.match(t, /search_messages\(from="p_linda"\) for what they sent/);
    const j = await call('find', { query: 'Mom', format: 'json' });
    assert.equal(Object.keys(j.structuredContent)[0], 'notice');
    assert.match(j.structuredContent.more, /search_messages\(from="p_linda"\)/);
  });

  it('reads a name plus a topic as that topic in their conversations', async () => {
    const { call } = await setup();
    const t = text(await call('find', { query: 'Sam cabin' }));
    assert.match(
      t,
      /Messages: no match for "Sam cabin" as typed\. Interpreted as "cabin" in conversations with Sam Ortiz \(5\) \/ Sam Lee \(1\)\./,
    );
    assert.match(t, /"Sam" matches 2 people; ask the user which one before acting\./);
    assert.equal(t.match(/#m1672/g)!.length, 2, 'listed once, then referenced'); // hit line + "(listed above)"
    const j = (await call('find', { query: 'Sam cabin', format: 'json' })).structuredContent;
    assert.deepEqual(j.interpreted_as, { name: 'Sam', text: 'cabin', person_ids: ['p_sam_ortiz', 'p_sam_lee'] });
    assert.equal(new Set(j.messages.map((m: any) => m.message_id)).size, j.messages.length);

    const lee = (await call('find', { query: 'Sam Lee car', format: 'json' })).structuredContent;
    assert.deepEqual(lee.interpreted_as.person_ids, ['p_sam_lee']);
    assert.ok(lee.messages.some((m: any) => m.message_id === 'm1679'));
    const recipe = (await call('find', { query: 'recipe from Mom', format: 'json' })).structuredContent;
    assert.deepEqual(recipe.interpreted_as, { name: 'Mom', text: 'recipe', person_ids: ['p_linda'] });
    assert.ok(recipe.messages.length >= 1);
    // Request phrasing is not the topic: "the link Sam sent about the cabin" searches "cabin".
    const phrased = (await call('find', { query: 'the link Sam Ortiz sent about the cabin', format: 'json' }))
      .structuredContent;
    assert.deepEqual(phrased.interpreted_as, { name: 'Sam Ortiz', text: 'cabin', person_ids: ['p_sam_ortiz'] });
    assert.ok(phrased.messages.some((m: any) => m.message_id === 'm1008'));

    const keys = await call('find', { query: 'car keys', format: 'json' });
    assert.equal(keys.structuredContent.interpreted_as, undefined, '"car" never resolves to Carter');
    assert.equal(keys.structuredContent.people.length, 0);
    const dad = await call('find', { query: 'Dad birthday' });
    assert.match(text(dad), /No match for the whole query, and no "birthday" in conversations with Robert Carter\./);
    assert.doesNotMatch(text(dad), /Interpreted/);
    const cabin = text(await call('find', { query: 'cabin' }));
    assert.doesNotMatch(cabin, /Interpreted|No match for the whole query/);
  });

  it('falls back to any word when no message has every word, with a hint', async () => {
    const { call } = await setup();
    const t = text(await call('find', { query: 'no car' }));
    assert.match(t, /No message has all of: no, car\. Closest matches \(some words or word roots\):/);
    assert.match(t, /#m1679/);
    assert.match(
      t,
      /For a person plus a topic, try search_messages\(query:"<topic>", with:"<name>"\)\. For a shared link: list_links\(query:"<topic>"\)\./,
    );
    const j = (await call('find', { query: 'no car', format: 'json' })).structuredContent;
    assert.equal(j.fallback, 'any_word');
    assert.ok(j.closest.length > 0);
    assert.ok(j.hint);
    const none = await call('find', { query: 'zebra', format: 'json' });
    assert.match(none.structuredContent.search_note, /Text inside photos and PDFs isn't searched/);
    assert.match(
      text(await call('find', { query: 'zebra' })),
      /Text inside photos and PDFs isn't searched; try list_attachments, then get_attachment mode=text\./,
    );
  });

  it('matches group references with filler words, former names and labels', async () => {
    const { store, call } = await setup();
    for (const q of ['cabin group', 'the cabin', 'cabin chat']) {
      assert.ok(
        (await call('find', { query: q, format: 'json' })).structuredContent.conversations.some(
          (c: any) => c.chat_id === 'iMessage;+;chat58213',
        ),
        q,
      );
    }
    const team = (await call('list_conversations', { query: 'product team group', format: 'json' })).structuredContent
      .conversations;
    assert.deepEqual(
      team.map((c: any) => c.title),
      ['Product Team'],
    );

    await store.manageGroup('rename', { chatId: 'iMessage;+;chat58213', title: 'Lake House' });
    const old = await call('find', { query: 'Cabin Weekend' });
    assert.match(text(old), /Lake House \(formerly Cabin Weekend 🏔️\)/);
    const oldJson = (await call('list_conversations', { query: 'cabin weekend', format: 'json' })).structuredContent
      .conversations;
    assert.equal(oldJson[0].title, 'Lake House');
    assert.equal(oldJson[0].formerly, 'Cabin Weekend 🏔️');
    assert.doesNotMatch(text(await call('find', { query: 'Lake House' })), /formerly/);

    assert.doesNotMatch(text(await call('find', { query: 'zebra' })), /Labels:/);
    store.labelChat('iMessage;+;chat58213', ['trip'], []);
    for (const q of ['trip', 'trips', 'trip chats']) {
      assert.ok(
        (await call('find', { query: q, format: 'json' })).structuredContent.conversations.some(
          (c: any) => c.chat_id === 'iMessage;+;chat58213',
        ),
        q,
      );
    }
    assert.equal(
      (await call('find', { query: 'tri', format: 'json' })).structuredContent.conversations.length,
      0,
      'labels never match a fragment',
    );
    assert.match(text(await call('find', { query: 'zebra' })), /Labels: #trip \(1\) → list_conversations\(label=…\)/);
    assert.deepEqual((await call('find', { query: 'zebra', format: 'json' })).structuredContent.labels, [
      { name: 'trip', count: 1 },
    ]);
    assert.equal(
      (await call('list_conversations', { query: 'trip', format: 'json' })).structuredContent.conversations.length,
      1,
    );
  });

  it('reads "what did Jo say about packing" and "Sam\'s cabin" as a person plus a topic', async () => {
    const { call } = await setup();
    for (const query of ['what did Jo say about packing', 'Jo say packing', "Jo's packing"]) {
      const t = text(await call('find', { query, limit_per_section: 3 }));
      assert.match(t, /Interpreted as "packing" in conversations with Jo Kim \(1\)\./, query);
    }
    assert.match(
      text(await call('find', { query: "Sam's cabin" })),
      /Interpreted as "cabin" in conversations with Sam Ortiz/,
    );
  });

  it("falls back to any topic word inside the person's conversations", async () => {
    const { call } = await setup();
    const r = await call('find', { query: 'Jo packing zebra', format: 'json' });
    assert.deepEqual(r.structuredContent.interpreted_as, {
      name: 'Jo',
      text: 'packing zebra',
      person_ids: ['p_jo'],
      match: 'any_word',
    });
    assert.match(
      text(await call('find', { query: 'Jo packing zebra' })),
      /Interpreted as any of the words "packing zebra" in conversations with Jo Kim/,
    );
  });
});

describe('list_conversations', () => {
  it('normalizes labels and names the existing ones when a label is unknown', async () => {
    const { store, call } = await setup();
    const none = await call('list_conversations', { label: 'trip' });
    assert.equal(none.isError, true);
    assert.match(text(none), /Error label_not_found: .*\nFix: No labels exist yet/);
    store.labelChat('iMessage;+;chat58213', ['trip'], []);
    store.labelChat('iMessage;+;chat33107', ['work'], []);
    for (const label of ['trip', '#Trip', ' TRIP '])
      assert.equal(
        (await call('list_conversations', { label, format: 'json' })).structuredContent.conversations.length,
        1,
        label,
      );
    const plural = await call('list_conversations', { label: 'trips' });
    assert.equal(plural.isError, true);
    assert.match(
      text(plural),
      /Error label_not_found: No conversation has label "trips"\.\nFix: Labels: trip \(1\), work \(1\)\./,
    );
    const empty = await call('list_conversations', { label: 'trip', type: 'dm' });
    assert.equal(empty.isError, undefined);
    assert.equal(text(empty), 'No conversations match those filters.');
  });

  it('sorts needs_reply by triage: people first, then groups, broadcasts, unknown senders', async () => {
    const { call } = await setup();
    const rows = (await call('list_conversations', { needs_reply: true, format: 'json' })).structuredContent
      .conversations;
    const rank = (c: any) =>
      (({ undefined: 0, group: 1, broadcast: 2, 'unknown sender': 3 }) as Record<string, number>)[
        String(c.needs_reply_label)
      ];
    const ranks = rows.map(rank);
    assert.deepEqual(
      ranks,
      [...ranks].sort((x, y) => x - y),
      JSON.stringify(rows.map((c: any) => [c.title, c.needs_reply_label])),
    );
    assert.deepEqual(new Set(ranks), new Set([0, 1, 2, 3]));
    assert.ok(rows.some((c: any) => c.title === 'Sam Lee'));
    assert.match(text(await call('list_conversations', { needs_reply: true })), /needs reply \(unknown sender\)/);
  });

  it('read tools hand back person_ids for an ambiguous name instead of asking the user', async () => {
    const { call } = await setup();
    for (const r of [
      await call('list_conversations', { person: 'Sam' }),
      await call('search_messages', { query: 'cabin', with: 'Sam' }),
    ]) {
      assert.equal(r.isError, true);
      assert.match(text(r), /ambiguous_person/);
      assert.match(text(r), /Fix: Pass one of these person_ids/);
      assert.doesNotMatch(text(r), /Ask the user/);
    }
  });

  it('keyset pages never skip or repeat when a chat jumps to the top, and report the jump', async () => {
    const { store, call } = await setup();
    const full = (await call('list_conversations', { limit: 100, format: 'json' })).structuredContent.conversations.map(
      (c: any) => c.chat_id,
    );
    const p1 = (await call('list_conversations', { limit: 3, format: 'json' })).structuredContent;
    const target = full[6];
    await tick();
    await store.send({ chatId: target }, 'jumping to the top', [], 'auto', 'find-test-c03-1');
    const seen: string[] = p1.conversations.map((c: any) => c.chat_id);
    let cursor = p1.next_cursor;
    let moved: any[] = [];
    while (cursor) {
      const p = (await call('list_conversations', { limit: 3, cursor, format: 'json' })).structuredContent;
      seen.push(...p.conversations.map((c: any) => c.chat_id));
      moved = moved.concat(p.new_activity_since_first_page ?? []);
      cursor = p.next_cursor;
    }
    assert.equal(new Set(seen).size, seen.length, 'no chat repeats');
    assert.deepEqual([...seen, target].sort(), [...full].sort(), 'every chat but the one that jumped above the cursor');
    assert.ok(moved.some((m) => m.chat_id === target));
    const p2 = await call('list_conversations', { limit: 3, cursor: p1.next_cursor });
    assert.match(
      text(p2),
      /1 chat got new messages after page 1: .* \(re-list with active_after=2026-|1 chat got new messages after page 1: .* \(re-list with active_after=\d{4}-/,
    );
  });

  it('a reply between pages of needs_reply does not push an unseen chat past the cursor', async () => {
    const { store, call } = await setup();
    const before = (
      await call('list_conversations', { needs_reply: true, limit: 100, format: 'json' })
    ).structuredContent.conversations.map((c: any) => c.chat_id);
    const p1 = (await call('list_conversations', { needs_reply: true, limit: 3, format: 'json' })).structuredContent;
    for (const c of p1.conversations.slice(0, 2))
      await store.send({ chatId: c.chat_id }, 'on it', [], 'auto', `find-test-nr-${c.chat_id}`);
    const p2 = (
      await call('list_conversations', { needs_reply: true, limit: 3, cursor: p1.next_cursor, format: 'json' })
    ).structuredContent;
    assert.deepEqual(
      p2.conversations.map((c: any) => c.chat_id),
      before.slice(3, 6),
    );
  });

  it('rejects a cursor from other filters or another sort, accepts a new limit and old offset cursors', async () => {
    const { call } = await setup();
    const p1 = (await call('list_conversations', { type: 'dm', limit: 2, format: 'json' })).structuredContent;
    const other = await call('list_conversations', { type: 'group', limit: 2, cursor: p1.next_cursor });
    assert.match(text(other), /Error invalid_cursor: That cursor came from a different query or filters\./);
    const sorted = await call('list_conversations', { type: 'dm', sort: 'name', cursor: p1.next_cursor });
    assert.match(text(sorted), /Error invalid_cursor: That cursor came from sort=recent/);
    const wider = await call('list_conversations', { type: 'dm', limit: 5, cursor: p1.next_cursor, format: 'json' });
    assert.equal(wider.isError, undefined);
    const all = (
      await call('list_conversations', { type: 'dm', limit: 100, format: 'json' })
    ).structuredContent.conversations.map((c: any) => c.chat_id);
    assert.deepEqual(
      wider.structuredContent.conversations.map((c: any) => c.chat_id),
      all.slice(2, 7),
    );
    const legacy = (
      await call('list_conversations', {
        type: 'dm',
        limit: 2,
        cursor: encodeCursor({ k: 'lc', o: 2 }),
        format: 'json',
      })
    ).structuredContent;
    assert.deepEqual(
      legacy.conversations.map((c: any) => c.chat_id),
      all.slice(2, 4),
    );
    assert.match(text(await call('list_conversations', { cursor: 'null' })), /no_more_pages/);
  });
});

describe('search_messages', () => {
  it('a person as chat covers all their 1:1 threads; a chat_id stays one thread', async () => {
    const { call } = await setup();
    const t = text(await call('search_messages', { chat: 'Sam Ortiz', query: 'blue' }));
    assert.match(t, /#m1002/);
    assert.match(t, /all 3 1:1 threads with Sam Ortiz/);
    const j = (await call('search_messages', { chat: 'p_sam_ortiz', query: 'blue', format: 'json' })).structuredContent;
    assert.equal(j.chat_ids.length, 3);
    const one = await call('search_messages', { chat: 'iMessage;-;+15555550142', query: 'blue' });
    assert.match(text(one), /^No messages match\./);
    const lift = (await call('search_messages', { query: 'in:"Cabin Weekend" car', format: 'json' })).structuredContent;
    assert.ok(lift.hits.length > 0 && lift.hits.every((h: any) => h.chat_id === 'iMessage;+;chat58213'));
  });

  it("pages stay inside the first page's snapshot and reject a changed query", async () => {
    const { store, call } = await setup();
    const p1 = (await call('search_messages', { from: 'me', limit: 3, format: 'json' })).structuredContent;
    const all = (await call('search_messages', { from: 'me', limit: 6, format: 'json' })).structuredContent.hits.map(
      (h: any) => h.message_id,
    );
    await tick();
    await store.send({ chatId: 'iMessage;-;+15555550133' }, 'new one between pages', [], 'auto', 'find-test-sm-1');
    const p2 = (await call('search_messages', { from: 'me', limit: 3, cursor: p1.next_cursor, format: 'json' }))
      .structuredContent;
    assert.deepEqual(
      p2.hits.map((h: any) => h.message_id),
      all.slice(3, 6),
    );
    assert.equal(p2.total, p1.total);
    const q1 = (await call('search_messages', { query: 'the', limit: 2, format: 'json' })).structuredContent;
    assert.match(
      text(await call('search_messages', { query: 'dinner', limit: 2, cursor: q1.next_cursor })),
      /invalid_cursor/,
    );
    assert.equal(
      (await call('search_messages', { query: 'the', limit: 5, cursor: q1.next_cursor })).isError,
      undefined,
    );
    const lifted = (await call('search_messages', { query: 'from:me', limit: 1, format: 'json' })).structuredContent;
    assert.equal(
      (await call('search_messages', { from: 'me', limit: 1, cursor: lifted.next_cursor })).isError,
      undefined,
      'lifted tokens hash like the filters',
    );
    const rel = (await call('search_messages', { chat: 'Mom', after: '400d', limit: 5, format: 'json' }))
      .structuredContent;
    assert.equal(
      (await call('search_messages', { chat: 'Linda Carter', after: '400d', limit: 5, cursor: rel.next_cursor }))
        .isError,
      undefined,
      'relative times and resolved names still page',
    );
  });

  it('says why nothing matched, and falls back to any word for 2+ words', async () => {
    const { call } = await setup();
    const none = text(await call('search_messages', { query: 'zebra' }));
    assert.match(
      none,
      /^No messages match\. Every word must appear: try one distinctive word or a shorter stem \(booking → book\), or drop a filter\./,
    );
    assert.match(
      none,
      /Text inside photos and PDFs isn't searched; try list_attachments, then get_attachment mode=text\./,
    );
    const fb = text(await call('search_messages', { query: 'no car' }));
    assert.match(fb, /^No message has all of: no, car\. Closest matches \(some words or word roots\):/);
    const j = (await call('search_messages', { query: 'no car', format: 'json' })).structuredContent;
    assert.equal(j.total, 0);
    assert.deepEqual(j.hits, []);
    assert.equal(j.fallback, 'any_word');
    assert.ok(j.closest.length > 0);
    assert.match(
      text(await call('search_messages', { chat: 'Sam Ortiz', query: 'zebra' })),
      /with="p_sam_ortiz" also searches group chats/,
    );
  });

  it('prints each chat header once per run, flags strangers, and keeps hit numbers', async () => {
    const { call } = await setup();
    const t = text(await call('search_messages', { query: 'cabin' }));
    assert.equal(t.match(/^Sam Ortiz · 1:1 · chat_id iMessage;-;\+15555550142$/gm)!.length, 1, t);
    for (let n = 1; n <= 6; n++) assert.match(t, new RegExp(`^ +${n}\\. \\[`, 'm'));
    assert.match(
      text(await call('search_messages', { query: 'assistant' })),
      /\(555\) 555-0188 · 1:1 · not in Contacts · chat_id/,
    );
    const ctx = text(await call('search_messages', { query: 'cabin', context: 1 }));
    assert.match(ctx, /^ +1\.▶ /m);
    assert.match(ctx, /⋯/);
    assert.ok(ctx.startsWith('6 matches') && ctx.split('\n')[1] === UNTRUSTED_NOTICE);
  });

  it('json: notice first, participants as objects, attachment_type aliases', async () => {
    const { call } = await setup();
    const j = (await call('search_messages', { query: 'cabin', format: 'json' })).structuredContent;
    assert.equal(Object.keys(j)[0], 'notice');
    assert.deepEqual(j.chats['iMessage;+;chat58213'].participants[0], { person_id: 'p_sam_ortiz', name: 'Sam Ortiz' });
    for (const attachment_type of ['photo', ['photos'], 'Image']) {
      const r = (await call('search_messages', { attachment_type, format: 'json' })).structuredContent;
      assert.ok(
        r.hits.length > 0 && r.hits.every((h: any) => h.attachments.some((a: any) => a.kind === 'image')),
        JSON.stringify(attachment_type),
      );
    }
    const pdfs = (await call('search_messages', { query: 'has:pdf', format: 'json' })).structuredContent;
    assert.ok(pdfs.hits.every((h: any) => h.attachments.some((a: any) => a.kind === 'pdf')));
  });

  it('a code in a link preview title is neither shown nor searchable', async () => {
    const { call, store } = await setup();
    const m = store.receive('iMessage;-;+15555550133', 'p_jo', 'https://bank.example/verify');
    m.link = { url: 'https://bank.example/verify', title: 'Your verification code is 551204', site: 'bank.example' };
    assert.equal((await call('search_messages', { query: '551204', format: 'json' })).structuredContent.total, 0);
    assert.deepEqual((await call('list_links', { query: '551204', format: 'json' })).structuredContent.links, []);
    const shown = (await call('list_links', { query: 'verification', format: 'json' })).structuredContent.links;
    assert.deepEqual(
      shown.map((l: any) => l.title),
      ['Your verification code is [verification code hidden]'],
    );
    const hit = await call('search_messages', { query: 'verification code', chat: 'Jo Kim' });
    assert.match(text(hit), /\[link "Your verification code is \[verification code hidden\]"\]/);
    assert.doesNotMatch(text(hit), /551204/);
  });
});

describe('list_conversations keyset for every sort', () => {
  it('walks sort=name and sort=unread without repeats or gaps', async () => {
    const { call } = await setup();
    for (const sort of ['name', 'unread', 'recent']) {
      const full = (
        await call('list_conversations', { sort, limit: 100, format: 'json' })
      ).structuredContent.conversations.map((c: any) => c.chat_id);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const p = (await call('list_conversations', { sort, limit: 4, ...(cursor ? { cursor } : {}), format: 'json' }))
          .structuredContent;
        seen.push(...p.conversations.map((c: any) => c.chat_id));
        cursor = p.next_cursor ?? undefined;
      } while (cursor);
      assert.deepEqual(seen, full, sort);
    }
  });

  it('sort=unread and sort=name never repeat or drop a chat whose key changed between pages', async () => {
    const { store, call } = await setup();
    const p1 = (await call('list_conversations', { sort: 'unread', limit: 3, format: 'json' })).structuredContent;
    const first = p1.conversations[0].chat_id;
    await store.markRead(first, false);
    const seen: string[] = p1.conversations.map((c: any) => c.chat_id);
    let cursor = p1.next_cursor;
    while (cursor) {
      const p = (await call('list_conversations', { sort: 'unread', limit: 3, cursor, format: 'json' }))
        .structuredContent;
      seen.push(...p.conversations.map((c: any) => c.chat_id));
      cursor = p.next_cursor;
    }
    assert.equal(new Set(seen).size, seen.length, 'mark_read does not bring a chat back');
    assert.equal(
      seen.length,
      (await call('list_conversations', { limit: 100, format: 'json' })).structuredContent.total,
    );

    const g1 = (await call('list_conversations', { type: 'group', sort: 'name', limit: 1, format: 'json' }))
      .structuredContent;
    assert.equal(g1.conversations[0].title, 'Cabin Weekend 🏔️');
    await store.manageGroup('rename', { chatId: 'iMessage;+;chat33107', title: 'AAA Team' });
    const g2 = (
      await call('list_conversations', {
        type: 'group',
        sort: 'name',
        limit: 1,
        cursor: g1.next_cursor,
        format: 'json',
      })
    ).structuredContent;
    assert.equal(g2.conversations[0].title, 'AAA Team', 'a chat renamed above the cursor is still listed');
    const g3 = (
      await call('list_conversations', {
        type: 'group',
        sort: 'name',
        limit: 1,
        cursor: g2.next_cursor,
        format: 'json',
      })
    ).structuredContent;
    assert.equal(g3.conversations[0].title, 'Linda, Emma');
    assert.equal(g3.next_cursor, null);
  });
});
