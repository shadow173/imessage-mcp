import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeCtx } from './helpers/ctx.js';
import { connectTools, text } from './helpers/mcp.js';
import { newMockStore } from './helpers/mock.js';

// The whole seed sits in the year before "now", so every date from last year must carry its year, and dates in the
// new year must not. Dates without a year were read as the current year, ten minutes into it.
const NEW_YEAR = Date.parse('2027-01-01T00:10:00-05:00');

async function setup() {
  const store = newMockStore({ now: NEW_YEAR });
  return connectTools(makeCtx({}, { store }), 'test of dates across the new year');
}

describe('dates at Jan 1 00:10', () => {
  it('find: last-year times in the person summary and conversation lines carry the year', async () => {
    const { call } = await setup();
    const t = text(await call('find', { query: 'Sam Lee' }));
    assert.ok(
      t.includes(
        ' · last: Sam "also my friend has an extra ticket to the show…" Thu Dec 31 2026 21:40 EST · you: Sat Dec 12 2026 21:30 EST · needs reply',
      ),
      t,
    );
    assert.ok(t.includes("— Jo: yes!! I'll make a list (Thu Dec 31 2026 21:10 EST)"), t);
  });

  it('catch_up: "As of" has no year, "New since" an hour earlier does', async () => {
    const { call } = await setup();
    const t = text(await call('catch_up', { since: '1h', include_needs_reply: false }));
    assert.match(t, /\nAs of Fri Jan 1 00:10 EST\n\nNew since Thu Dec 31 2026 23:10 EST \(0\)\n/);
    assert.match(
      t,
      /\n4 unread chats with messages before Thu Dec 31 2026 23:10 EST not shown · omit since to include\n/,
    );
  });

  it('read_conversation and list_conversations stamp each message with its year', async () => {
    const { call } = await setup();
    const t = text(await call('read_conversation', { chat: 'Sam Lee', limit: 4 }));
    assert.ok(
      t.endsWith(
        [
          "  [Sat Dec 12 2026 21:02 EST] Sam: hey it's Sam from the climbing gym, nice meeting you!  #m1018",
          '  [Sat Dec 12 2026 21:30 EST] You: hey! same, see you Thursday   ✓ read 21:34  #m1019',
          '  [Wed Dec 30 2026 18:30 EST] Sam: are you coming to the gym thursday?  #m1020',
          '• [Thu Dec 31 2026 21:40 EST] Sam: also my friend has an extra ticket to the show saturday if you want it  #m1021',
        ].join('\n'),
      ),
      t,
    );
    const lc = text(await call('list_conversations', { limit: 3 }));
    assert.match(lc, /\(Thu Dec 31 2026 22:40 EST\)\n {2}chat_id iMessage;-;\+15555550142\n/);
  });

  it('set_reminder and get_status: times in the new year have no year in short form', async () => {
    const { call } = await setup();
    const r = (await call('set_reminder', { chat: 'Jo Kim', remind_at: '30min' })).structuredContent;
    assert.equal(r.remind_at, '2027-01-01T00:40:00-05:00');
    assert.equal(r.remind_at_local, 'Fri Jan 1 00:40 EST');
    const s = (await call('get_status')).structuredContent;
    assert.equal(s.now_local, 'Fri Jan 1 2027 00:10 EST');
  });
});
