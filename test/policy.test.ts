import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../src/lib/errors.js';
import { type ManageGroupInput, validateCreateGroup, validateGroupChange } from '../src/policy/groupArgs.js';
import {
  assertChangeable,
  assertEditBudget,
  assertInWindow,
  CHANGE_WINDOWS,
  type ChangeKind,
  windowPassedError,
} from '../src/policy/messageChanges.js';
import { type GroupAction, ME, type Message } from '../src/store/types.js';

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 9, 17, 20, 0, 0);

/** The ToolError fn throws, or undefined when it returns. */
function thrown(fn: () => unknown): ToolError | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  return undefined;
}

const msg = (over: Partial<Message> = {}): Message => ({
  messageId: 'm1',
  chatId: 'iMessage;-;+15555550142',
  senderId: ME,
  service: 'iMessage',
  sentAt: NOW - 60_000,
  text: 'running 5 late',
  isRead: true,
  reactions: [],
  attachmentIds: [],
  status: 'delivered',
  ...over,
});

describe('assertChangeable', () => {
  const rows: [string, Partial<Message>, ChangeKind, string | undefined][] = [
    ['your delivered iMessage', {}, 'edit', undefined],
    ['your delivered iMessage', {}, 'unsend', undefined],
    ['a conversation event', { system: { type: 'renamed', detail: 'named it' } }, 'edit', 'not_a_message'],
    ['a conversation event', { system: { type: 'renamed', detail: 'named it' } }, 'unsend', 'not_a_message'],
    ["someone else's message", { senderId: 'p_sam' }, 'edit', 'not_yours'],
    ["someone else's message", { senderId: 'p_sam' }, 'unsend', 'not_yours'],
    ['an unsent message', { unsent: true }, 'edit', 'unsent'],
    ['an already unsent message (the tool reports it unchanged)', { unsent: true }, 'unsend', undefined],
    ['an unsent message that had failed', { unsent: true, status: 'failed' }, 'unsend', undefined],
    ['an undelivered message', { status: 'failed' }, 'edit', 'not_delivered'],
    ['an undelivered message', { status: 'failed' }, 'unsend', 'not_delivered'],
    ['an SMS', { service: 'SMS' }, 'edit', 'not_imessage'],
    ['an RCS message', { service: 'RCS' }, 'unsend', 'not_imessage'],
  ];
  for (const [what, over, kind, code] of rows)
    it(`${kind} ${what} → ${code ?? 'allowed'}`, () => {
      const e = thrown(() => assertChangeable(msg(over), kind));
      assert.equal(e?.code, code);
      if (e) assert.ok(e.fix, 'every refusal says what to do instead');
    });

  it('names the verb and the service in the message', () => {
    assert.equal(
      thrown(() => assertChangeable(msg({ service: 'SMS' }), 'edit'))?.message,
      'Only iMessages can be edited, not SMS.',
    );
    assert.equal(
      thrown(() => assertChangeable(msg({ status: 'failed' }), 'unsend'))?.message,
      "That message was never delivered, so it can't be unsent.",
    );
  });
});

describe('assertInWindow', () => {
  const rows: [ChangeKind, number, string | undefined][] = [
    ['edit', 0, undefined],
    ['edit', CHANGE_WINDOWS.editMs, undefined],
    ['edit', CHANGE_WINDOWS.editMs + 1, 'edit_window_passed'],
    ['unsend', CHANGE_WINDOWS.unsendMs, undefined],
    ['unsend', CHANGE_WINDOWS.unsendMs + 1, 'unsend_window_passed'],
    ['unsend', 10 * 60_000, 'unsend_window_passed'],
  ];
  for (const [kind, age, code] of rows)
    it(`${kind} ${age / 1000}s after sending → ${code ?? 'allowed'}`, () => {
      assert.equal(thrown(() => assertInWindow(msg({ sentAt: NOW - age }), kind, NOW, TZ))?.code, code);
    });
});

describe('assertEditBudget', () => {
  const history = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `v${i}`, at: NOW - 60_000 + i }));
  for (const [edits, code] of [
    [0, undefined],
    [4, undefined],
    [5, 'edit_limit'],
  ] as const)
    it(`${edits} earlier edits → ${code ?? 'allowed'}`, () => {
      assert.equal(thrown(() => assertEditBudget({ editHistory: history(edits) }))?.code, code);
    });
});

describe('windowPassedError', () => {
  it('says when it was sent, how long ago, and what is still possible', () => {
    const u = windowPassedError('unsend', { sentAt: NOW - 3 * 60_000, service: 'iMessage', editHistory: [] }, NOW, TZ);
    assert.equal(u.code, 'unsend_window_passed');
    assert.equal(u.message, 'Sent at 15:57:00 (3m 0s ago); messages can only be unsent within 2 minutes of sending.');
    assert.equal(
      u.fix,
      'It can still be edited with edit_message until 16:12, or send a correction with send_message. Ask the user which.',
    );
    assert.equal(
      windowPassedError('unsend', { sentAt: NOW - 3 * 60_000, service: 'SMS' }, NOW, TZ).fix,
      'Send a correction with send_message after the user approves the wording.',
    );
    const ed = windowPassedError('edit', { sentAt: NOW - 20 * 60_000, service: 'iMessage' }, NOW, TZ);
    assert.equal(ed.code, 'edit_window_passed');
    assert.match(ed.message, /\(20m 0s ago\); messages can only be edited within 15 minutes of sending\./);
  });
});

describe('validateCreateGroup', () => {
  it('needs participants and trims the title', () => {
    assert.equal(thrown(() => validateCreateGroup({}))?.code, 'need_participants');
    assert.match(
      thrown(() => validateCreateGroup({ participants: [], person: 'Sam' }))!.fix!,
      /person is only for add/,
    );
    assert.deepEqual(validateCreateGroup({ participants: ['Sam', 'Jo'], title: '  Lake House ' }), {
      participants: ['Sam', 'Jo'],
      title: 'Lake House',
    });
    assert.equal(validateCreateGroup({ participants: ['Sam', 'Jo'], title: '   ' }).title, undefined);
  });
});

describe('validateGroupChange', () => {
  const rows: [Exclude<GroupAction, 'create'>, ManageGroupInput, string | object][] = [
    ['rename', {}, 'title_required'],
    ['rename', { title: ' \t' }, 'title_required'],
    ['rename', { title: '  Lake House ' }, { action: 'rename', title: 'Lake House' }],
    ['rename', { title: '' }, { action: 'rename', title: '' }],
    ['add', {}, 'need_person'],
    ['add', { person: '' }, 'need_person'],
    ['add', { person: 'Jo' }, { action: 'add', person: 'Jo' }],
    ['remove', { participants: ['Jo'] }, 'need_person'],
    ['remove', { person: 'Jo' }, { action: 'remove', person: 'Jo' }],
    ['set_icon', {}, 'icon_required'],
    ['set_icon', { image_base64: 'aGk=', clear_icon: true }, 'icon_required'],
    ['set_icon', { image_base64: 'aGk=' }, { action: 'set_icon', imageBase64: 'aGk=' }],
    ['set_icon', { clear_icon: true }, { action: 'set_icon', imageBase64: null }],
    ['set_icon', { clear_icon: false, image_base64: '' }, 'icon_required'],
    ['leave', {}, { action: 'leave' }],
  ];
  for (const [action, args, want] of rows)
    it(`${action} ${JSON.stringify(args)} → ${typeof want === 'string' ? want : 'ok'}`, () => {
      if (typeof want === 'string')
        assert.equal(thrown(() => validateGroupChange(action, args, 'Product Team'))?.code, want);
      else assert.deepEqual(validateGroupChange(action, args, 'Product Team'), want);
    });

  it('names the group when a title is only spaces', () => {
    assert.equal(
      thrown(() => validateGroupChange('rename', { title: '  ' }, 'Product Team'))?.message,
      'title is only spaces, so "Product Team" was not renamed. Nothing was sent.',
    );
  });
});
