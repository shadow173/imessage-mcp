import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normLabel, senderLabels } from '../src/domain/naming.js';
import { ToolError } from '../src/lib/errors.js';
import {
  chatCandidate,
  dmChatFor,
  dmChatsFor,
  isExactChatRef,
  labelMatches,
  matchPeople,
  personCandidate,
  requireChat,
  resolveChat,
  resolveChatScope,
  resolvePerson,
  siblingDms,
  titleMatches,
} from '../src/lib/resolve.js';
import type { ChatTarget } from '../src/store/types.js';
import { type Chat, ME } from '../src/store/types.js';
import { newMockStore } from './helpers/mock.js';

const fresh = () => newMockStore();
const S = fresh();
const CABIN = 'iMessage;+;chat58213';
const SAM_O = 'iMessage;-;+15555550142';
const SAM_O_SMS = 'SMS;-;+15555550142';
const SAM_O_EMAIL = 'iMessage;-;sam.ortiz@example.com';

function err(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  assert.fail('expected a ToolError');
}
const chatOf = (t: ChatTarget) => ('chat' in t ? t.chat.chatId : `new:${t.newAddress}`);
const ids = (e: ToolError) => (e.candidates ?? []).map((c) => c.id);

describe('scoring tiers', () => {
  const score = (q: string, pid: string) => matchPeople(S, q).find((h) => h.item.personId === pid)?.score ?? 0;
  it('exact 3, whole word 2, word prefix 1.5, company 1, mid-word 0', () => {
    assert.equal(score('Linda Carter', 'p_linda'), 3);
    assert.equal(score('Mom', 'p_linda'), 3);
    assert.equal(score('Carter', 'p_linda'), 2);
    assert.equal(score('Linda', 'p_linda'), 2);
    assert.equal(score('Rob', 'p_robert'), 1.5);
    assert.equal(score('Northwind', 'p_priya'), 1);
    assert.equal(score('arter', 'p_linda'), 0);
    assert.equal(score('bert', 'p_robert'), 0);
    assert.equal(matchPeople(S, 'Mom')[0].via, 'nickname');
  });
  it('mid-word fragments never resolve a chat, in either mode', () => {
    for (const q of ['end', 'eek', 'abin', 'uct', 'Rod', 'nda, Em']) {
      assert.equal(err(() => resolveChat(S, q)).code, 'chat_not_found', q);
      assert.equal(err(() => resolveChat(S, q, true)).code, 'chat_not_found', q);
    }
  });
  it('reads resolve a lone word prefix; strict writes ask', () => {
    assert.equal(chatOf(resolveChat(S, 'cab')), CABIN);
    const e = err(() => resolveChat(S, 'cab', false, { strict: true }));
    assert.equal(e.code, 'ambiguous_chat');
    assert.deepEqual(ids(e), [CABIN]);
    assert.match(e.fix!, /^Ask the user which one/);
    assert.equal(resolvePerson(S, 'Rob').personId, 'p_robert');
    const p = err(() => resolvePerson(S, 'Rob', { strict: true }));
    assert.equal(p.code, 'ambiguous_person');
    assert.deepEqual(ids(p), ['p_robert']);
  });
  it('allowNew is strict by default; whole words and exact names still resolve', () => {
    assert.equal(err(() => resolveChat(S, 'cab', true)).code, 'ambiguous_chat');
    assert.equal(chatOf(resolveChat(S, 'cabin', true)), CABIN);
    assert.equal(chatOf(resolveChat(S, 'Product Team', true)), 'iMessage;+;chat33107');
    assert.equal(chatOf(resolveChat(S, 'Emma', true)), 'new:+15555550144');
    assert.equal(err(() => resolveChat(S, 'Emma')).code, 'no_conversation');
    assert.equal(chatOf(resolveChat(S, 'Linda, Emma', true)), 'iMessage;+;chat71940');
    assert.equal(chatOf(resolveChat(S, 'Cabin Weekend', true)), CABIN);
    assert.equal(chatOf(resolveChat(S, 'Mom', true)), 'iMessage;-;+15555550111');
    assert.equal(chatOf(resolveChat(S, 'Jo', true)), 'iMessage;-;+15555550133');
  });
  it('"Sam" is ambiguous; reads and writes word the Fix differently', () => {
    const read = err(() => resolveChat(S, 'Sam'));
    assert.equal(read.code, 'ambiguous_chat');
    assert.deepEqual(ids(read).sort(), ['p_sam_lee', 'p_sam_ortiz']);
    assert.match(read.fix!, /^Pass one of these person_ids/);
    assert.doesNotMatch(read.fix!, /Ask the user/);
    assert.match(err(() => resolveChat(S, 'Sam', true)).fix!, /^Ask the user which one/);
    const rp = err(() => resolvePerson(S, 'Sam'));
    assert.equal(rp.code, 'ambiguous_person');
    assert.match(rp.fix!, /^Pass one of these person_ids/);
    assert.match(rp.fix!, /drop the filter/);
    assert.match(
      err(() => resolvePerson(S, 'Sam', { strict: true })).fix!,
      /^Ask the user which one they mean, then pass that person_id/,
    );
  });
});

describe('alias vs name', () => {
  it("an alias shadowing other people's names wins reads but is ambiguous on writes", () => {
    const s = fresh();
    s.updatePerson('p_linda', { addAliases: ['Sam'] });
    assert.equal(resolvePerson(s, 'Sam').personId, 'p_linda');
    assert.equal(chatOf(resolveChat(s, 'Sam')), 'iMessage;-;+15555550111');
    const e = err(() => resolvePerson(s, 'Sam', { strict: true }));
    assert.equal(e.code, 'ambiguous_person');
    assert.deepEqual(ids(e).sort(), ['p_linda', 'p_sam_lee', 'p_sam_ortiz']);
    assert.match(e.message, /saved alias of Linda Carter/);
    assert.equal(err(() => resolveChat(s, 'Sam', true)).code, 'ambiguous_chat');
  });
  it('an alias that disambiguates a shared first name is honoured on writes', () => {
    const s = fresh();
    s.updatePerson('p_sam_ortiz', { addAliases: ['Sam'] });
    assert.equal(resolvePerson(s, 'Sam', { strict: true }).personId, 'p_sam_ortiz');
    assert.equal(chatOf(resolveChat(s, 'Sam', true)), SAM_O);
  });
  it("an alias on an unknown number never quietly takes a contact's name on writes", () => {
    const s = fresh();
    s.updatePerson('p_5555550188', { addAliases: ['Linda'] });
    assert.equal(err(() => resolveChat(s, 'Linda', true)).code, 'ambiguous_chat');
  });
});

describe('addresses', () => {
  it('write paths match only exact handles; fragments become new addresses', () => {
    assert.equal(chatOf(resolveChat(S, '50142', true)), 'new:50142');
    assert.equal(chatOf(resolveChat(S, '550177', true)), 'new:550177');
    // 4 digits on a write is the tail of a number, never a new short code
    const tail = err(() => resolveChat(S, '0142', true));
    assert.equal(tail.code, 'ambiguous_chat');
    assert.match(tail.message, /only 4 digits.*It is the end of Sam Ortiz\./);
    assert.deepEqual(
      tail.candidates!.map((c) => c.id),
      ['p_sam_ortiz'],
    );
    assert.equal(err(() => resolveChat(S, '0111', true)).candidates![0].id, 'p_linda');
    const none = err(() => resolveChat(S, '9876', true));
    assert.equal(none.code, 'chat_not_found');
    assert.match(none.fix!, /US short codes have 5 or 6 digits/);
    assert.equal(chatOf(resolveChat(S, '55550142', true)), 'new:+55550142');
    assert.equal(chatOf(resolveChat(S, 'ortiz@example.com', true)), 'new:ortiz@example.com');
    assert.equal(chatOf(resolveChat(S, '28734', true)), 'SMS;-;28734');
    assert.equal(chatOf(resolveChat(S, '(555) 555-0142', true)), SAM_O);
    assert.equal(chatOf(resolveChat(S, '+15555550142', true)), SAM_O);
    assert.equal(chatOf(resolveChat(S, 'sam.ortiz@example.com', true)), SAM_O);
    const t = resolveChat(S, '(555) 555-1234', true);
    assert.ok('newAddress' in t && t.newAddress === '+15555551234');
  });
  it('a chat_id or number with no conversation yet says nothing has gone out as far as the Mac can see', () => {
    const synthetic = err(() => requireChat(S, 'any;-;+15555550123'));
    assert.equal(synthetic.code, 'chat_not_found');
    assert.match(
      synthetic.message,
      /^No conversation with \(555\) 555-0123 is in chat\.db yet\. If a send to it just came back MAY_HAVE_COMPLETED or unconfirmed, it has not gone out as far as the Mac can see\.$/,
    );
    assert.match(synthetic.fix!, /^Ask the user before sending again/);
    assert.match(err(() => requireChat(S, '+1 555 555 0123')).message, /no message to or from it is in chat\.db/);
    assert.match(
      err(() => requireChat(S, 'iMessage;+;chat000')).message,
      /^No conversation has chat_id "iMessage;\+;chat000"\.$/,
    );
  });
  it('reads keep suffix lookups; exact handles outrank suffixes', () => {
    assert.equal(requireChat(S, '0142').chatId, SAM_O);
    assert.ok(matchPeople(S, '0142').some((h) => h.item.personId === 'p_sam_ortiz' && h.score === 1));
    assert.equal(matchPeople(S, '28734')[0].score, 3);
    assert.equal(err(() => requireChat(S, '0142', { strict: true })).code, 'ambiguous_chat');
    assert.equal(err(() => requireChat(S, '9876', { strict: true })).code, 'chat_not_found');
  });
  it('person_not_found for an address says so and never asks for a number', () => {
    const e = err(() => resolvePerson(S, '+15555551234'));
    assert.equal(e.code, 'person_not_found');
    assert.equal(e.message, 'No contact or conversation uses (555) 555-1234.');
    assert.doesNotMatch(e.fix!, /pass a phone number/);
    assert.equal(err(() => resolvePerson(S, '0142', { strict: true })).code, 'person_not_found');
    assert.equal(resolvePerson(S, '+15555550199', { strict: true }).personId, 'p_5555550199');
    const n = err(() => resolvePerson(S, 'Sam from the climbing gym'));
    assert.match(n.fix!, /find or search_messages with those words/);
  });
  it('fragments: 7-digit phone and email fragments, read-only', () => {
    assert.deepEqual(
      matchPeople(S, '555-0188').map((h) => h.item.personId),
      [],
    );
    const f = matchPeople(S, '555-0188', { fragments: true });
    assert.deepEqual(
      f.map((h) => [h.item.personId, h.score]),
      [['p_5555550188', 2]],
    );
    assert.deepEqual(matchPeople(S, '555', { fragments: true }), []);
    assert.deepEqual(
      matchPeople(S, 'priya@', { fragments: true }).map((h) => h.item.personId),
      ['p_priya'],
    );
    assert.ok(matchPeople(S, 'northwind.example', { fragments: true }).some((h) => h.item.personId === 'p_priya'));
    const inc = err(() => resolveChat(S, '555-0188', true));
    assert.equal(inc.code, 'chat_not_found');
    assert.equal(inc.message, '"555-0188" is not a complete phone number or email.');
    assert.match(inc.fix!, /^Pass all 10 digits/);
    const pinc = err(() => resolvePerson(S, '555-0188'));
    assert.equal(pinc.code, 'person_not_found');
    assert.doesNotMatch(pinc.fix!, /phone number or email also works/);
    assert.equal(resolvePerson(S, 'priya@').personId, 'p_priya');
    assert.equal(err(() => resolvePerson(S, 'priya@', { strict: true })).code, 'person_not_found');
    assert.equal(
      err(() => resolveChat(S, 'priya@', true)).message,
      '"priya@" is not a complete phone number or email.',
    );
  });
  it('chat_not_found for a business name explains aliases', () => {
    const e = err(() => resolveChat(S, 'Northwind Bank'));
    assert.equal(e.code, 'chat_not_found');
    assert.match(e.fix!, /update_person add_aliases/);
  });
});

describe('chat ids and 1:1 threads', () => {
  it('an exact chat_id wins over a same-tail thread; prefix variants pick the most recent', () => {
    assert.equal(requireChat(S, SAM_O_SMS).chatId, SAM_O_SMS);
    assert.equal(requireChat(S, SAM_O).chatId, SAM_O);
    assert.equal(requireChat(S, 'any;-;+15555550142').chatId, SAM_O);
    assert.equal(chatOf(resolveChat(S, SAM_O_SMS, true)), SAM_O_SMS);
    assert.equal(err(() => requireChat(S, 'iMessage;-;+19999999999')).code, 'chat_not_found');
  });
  it('dmChatsFor lists every 1:1 by recency; siblings and scopes follow', () => {
    assert.deepEqual(
      dmChatsFor(S, 'p_sam_ortiz').map((c) => c.chatId),
      [SAM_O, SAM_O_EMAIL, SAM_O_SMS],
    );
    assert.equal(dmChatFor(S, 'p_sam_ortiz')!.chatId, SAM_O);
    assert.deepEqual(
      siblingDms(S, S.chat(SAM_O_SMS)!).map((c) => c.chatId),
      [SAM_O, SAM_O_EMAIL],
    );
    assert.deepEqual(siblingDms(S, S.chat(CABIN)!), []);
    assert.deepEqual(resolveChatScope(S, 'Sam Ortiz'), {
      chat: S.chat(SAM_O),
      chatIds: [SAM_O, SAM_O_EMAIL, SAM_O_SMS],
      personId: 'p_sam_ortiz',
    });
    assert.deepEqual(resolveChatScope(S, 'p_sam_ortiz').chatIds.length, 3);
    assert.deepEqual(resolveChatScope(S, SAM_O_SMS), { chat: S.chat(SAM_O_SMS), chatIds: [SAM_O_SMS] });
    assert.deepEqual(resolveChatScope(S, 'Cabin Weekend').chatIds, [CABIN]);
    assert.deepEqual(resolveChatScope(S, 'Mom').chatIds, ['iMessage;-;+15555550111']);
  });
});

describe('sender labels', () => {
  it('"First L." labels and trailing punctuation resolve', () => {
    assert.equal(resolvePerson(S, 'Sam L.').personId, 'p_sam_lee');
    assert.equal(resolvePerson(S, 'Sam O.').personId, 'p_sam_ortiz');
    assert.equal(resolvePerson(S, 'sam l').personId, 'p_sam_lee');
    assert.equal(resolvePerson(S, 'Sam L.', { strict: true }).personId, 'p_sam_lee');
    assert.equal(resolvePerson(S, 'Linda Carter.').personId, 'p_linda');
    assert.equal(err(() => resolvePerson(S, 'Sam X.')).code, 'person_not_found');
  });
  it('invariant: every transcript sender label resolves to its sender (or, when shared globally, lists them)', () => {
    for (const chat of S.chats()) {
      for (const [pid, label] of senderLabels(S, chat)) {
        if (pid === ME) continue;
        try {
          assert.equal(resolvePerson(S, label).personId, pid, `${label} in ${chat.chatId}`);
        } catch (e) {
          if (!(e instanceof ToolError) || e.code !== 'ambiguous_person') throw e;
          assert.ok(ids(e).includes(pid), `${label} candidates miss ${pid}`);
          assert.equal(chat.type, 'dm', `${label} must be unique in group ${chat.chatId}`);
        }
      }
    }
  });
});

describe('filler words and near matches', () => {
  it('group words resolve groups only, in reads and writes', () => {
    for (const q of [
      'cabin group',
      'the cabin group',
      'weekend cabin',
      'cabin gc',
      'the cabin chat',
      'cabin group chat',
    ]) {
      assert.equal(chatOf(resolveChat(S, q)), CABIN, q);
      assert.equal(chatOf(resolveChat(S, q, true)), CABIN, q);
    }
    assert.equal(chatOf(resolveChat(S, 'product team group', true)), 'iMessage;+;chat33107');
    assert.equal(chatOf(resolveChat(S, 'Mom chat', true)), 'iMessage;-;+15555550111');
    assert.equal(chatOf(resolveChat(S, 'my mom', true)), 'iMessage;-;+15555550111');
  });
  it('never routes "Jo group" to Jo\'s 1:1; all-filler queries are not found', () => {
    assert.equal(err(() => resolveChat(S, 'Jo group', true)).code, 'chat_not_found');
    assert.equal(err(() => resolveChat(S, 'Jo group')).code, 'chat_not_found');
    for (const q of ['the group', 'group chat', 'the chat'])
      assert.equal(err(() => resolveChat(S, q)).code, 'chat_not_found', q);
  });
  it('chat_not_found offers near matches without auto-resolving', () => {
    const e = err(() => resolveChat(S, 'cabin trip', true));
    assert.equal(e.code, 'chat_not_found');
    assert.deepEqual(ids(e), [CABIN]);
    assert.match(
      e.fix!,
      /^No exact match\. If one of these is the chat the user means, pass its chat_id; otherwise ask the user\./,
    );
    assert.deepEqual(ids(err(() => resolveChat(S, 'weekender plans'))), [CABIN]);
    const none = err(() => resolveChat(S, 'book club'));
    assert.equal(none.candidates, undefined);
    assert.match(none.fix!, /list_conversations with type=group/);
  });
  it('titleMatches for read-side lists', () => {
    assert.ok(titleMatches('Cabin Weekend 🏔️', 'cabin group'));
    assert.ok(titleMatches('Cabin Weekend 🏔️', 'weekend cabin'));
    assert.ok(titleMatches('Cabin Weekend 🏔️', 'eek'));
    assert.ok(titleMatches('Lake House', 'cabin', ['Cabin Weekend 🏔️']));
    assert.ok(!titleMatches('Cabin Weekend 🏔️', 'group chat'));
    assert.ok(!titleMatches('Product Team', 'cabin group'));
  });
});

describe('former titles and exact refs', () => {
  const withFormer = () => {
    const s = fresh();
    const c = s.chat(CABIN)! as Chat & { formerTitles?: string[] };
    c.displayName = 'Lake House';
    c.formerTitles = ['Cabin Weekend 🏔️'];
    return s;
  };
  it('an exact former name resolves at whole-word strength; fragments of it do not', () => {
    const s = withFormer();
    assert.equal(chatOf(resolveChat(s, 'Cabin Weekend', true)), CABIN);
    assert.equal(chatOf(resolveChat(s, 'cabin weekend 🏔️')), CABIN);
    const e = err(() => resolveChat(s, 'cabin', true));
    assert.equal(e.code, 'chat_not_found');
    assert.deepEqual(ids(e), [CABIN]);
    assert.equal(e.candidates![0].label, 'Lake House (formerly Cabin Weekend 🏔️)');
    assert.equal(chatOf(resolveChat(s, e.candidates![0].label, true)), CABIN);
    assert.equal(chatCandidate(s, s.chat(CABIN)!, { formerly: 'X' }).label, 'Lake House (formerly X)');
  });
  it("a current exact title beats another group's former name", () => {
    const s = withFormer();
    const team = s.chat('iMessage;+;chat33107')!;
    team.displayName = 'Cabin Weekend';
    assert.equal(chatOf(resolveChat(s, 'Cabin Weekend', true)), 'iMessage;+;chat33107');
  });
  it('isExactChatRef accepts the chat_id or the full title only', () => {
    const c = S.chat(CABIN)!;
    for (const q of ['Cabin Weekend', 'cabin weekend 🏔️', 'Cabin Weekend 🏔️', CABIN, 'any;+;chat58213'])
      assert.ok(isExactChatRef(S, c, q), q);
    for (const q of ['cabin', 'weekend', 'cabin group']) assert.ok(!isExactChatRef(S, c, q), q);
    assert.ok(!isExactChatRef(S, S.chat('iMessage;+;chat33107')!, 'team'));
  });
});

describe('lead words and decorations', () => {
  it('my/our/the match nicknames and aliases, never Contacts names', () => {
    const s = fresh();
    s.updatePerson('p_marcus', { addAliases: ['landlord'] });
    s.updatePerson('p_jo', { addAliases: ['my roommate'] });
    assert.equal(resolvePerson(s, 'my landlord').personId, 'p_marcus');
    assert.equal(resolvePerson(s, 'the landlord', { strict: true }).personId, 'p_marcus');
    assert.equal(resolvePerson(s, 'the roommate').personId, 'p_jo');
    assert.equal(resolvePerson(s, 'roommate').personId, 'p_jo');
    assert.equal(resolvePerson(s, 'my mom', { strict: true }).personId, 'p_linda');
    assert.equal(resolvePerson(s, 'My Dad').personId, 'p_robert');
    assert.equal(err(() => resolvePerson(s, 'my sister')).code, 'person_not_found');
    assert.equal(err(() => resolvePerson(s, 'my')).code, 'person_not_found');
  });
  it('copied labels with a trailing (aka …) / (person_id …) resolve; a title with parentheses still wins', () => {
    assert.equal(resolvePerson(S, 'Linda Carter (aka Mom)').personId, 'p_linda');
    assert.equal(resolvePerson(S, 'Sam Lee (person_id p_sam_lee)').personId, 'p_sam_lee');
    assert.equal(chatOf(resolveChat(S, 'Sam Ortiz (aka Sammy)', true)), SAM_O);
    assert.equal(chatOf(resolveChat(S, `Cabin Weekend 🏔️ (chat_id ${CABIN})`, true)), CABIN);
    const s = fresh();
    s.chat(CABIN)!.displayName = 'Trip (2026)';
    assert.equal(chatOf(resolveChat(s, 'Trip (2026)', true)), CABIN);
  });
});

describe('candidates', () => {
  it('person candidates carry note, aka, labels, counts, last date and a redacted snippet', () => {
    const s = fresh();
    s.updatePerson('p_sam_lee', { note: 'Met at the climbing gym', addLabels: ['climbing'], addAliases: ['gym Sam'] });
    const d = personCandidate(s, s.person('p_sam_lee')!).detail!;
    assert.match(
      d,
      /^note: Met at the climbing gym · aka gym Sam · #climbing · 4 msgs · last .+ "also my friend has an extra ticket to t…" · \(555\) 555-0177$/,
    );
    const unknown = personCandidate(s, s.person('p_5555550188')!).detail!;
    assert.match(unknown, /not in Contacts/);
    assert.doesNotMatch(unknown, /"/);
    assert.deepEqual(matchPeople(s, 'climbing'), []);
  });
  it('a code in the last message never reaches a candidate', () => {
    const s = fresh();
    s.updatePerson('p_28734', { addAliases: ['Northwind Bank'] });
    assert.doesNotMatch(JSON.stringify(personCandidate(s, s.person('p_28734')!)), /\d{6}/);
    const m = s.summarizeChat('iMessage;-;+15555550177').lastMessage!;
    m.text = 'my code is 482913 lol';
    assert.doesNotMatch(personCandidate(s, s.person('p_sam_lee')!).detail!, /482913/);
  });
  it('group candidates name members and recency', () => {
    assert.match(chatCandidate(S, S.chat(CABIN)!).detail!, /^group of 4 · Sam Ortiz, Jo Kim, Sam Lee · last /);
  });
});

describe('labels', () => {
  it('normLabel and labelMatches use words, plurals and #, never substrings', () => {
    assert.equal(normLabel('  #Trip '), 'trip');
    assert.ok(labelMatches('trip', ['trip']));
    assert.ok(labelMatches('trips', ['trip']));
    assert.ok(labelMatches('#Trip', ['trip']));
    assert.ok(labelMatches('show my trip chats', ['trip']));
    assert.ok(labelMatches('home stuff', ['home stuff']));
    assert.ok(labelMatches('my home stuff chats', ['home stuff']));
    assert.ok(!labelMatches('tri', ['trip']));
    assert.ok(!labelMatches('trip', ['triple']));
    assert.ok(!labelMatches('', ['trip']));
  });
});
