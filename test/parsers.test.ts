import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlistUid, type PlistValue, parseBplist, unarchive } from '../src/live/bplist.js';
import { decodeAttributedBody } from '../src/live/typedstream.js';
import { ATTRIBUTED_BODY, PLIST } from './fixtures/blobs.js';
import { encodeAttributedBody } from './helpers/typedstream.js';

// Both formats arrive inside other people's messages, so malformed input must fail fast with an error the store can
// catch: never a hang, a stack overflow or a polluted prototype.

/** Assembles a bplist00 from raw object bytes, with trailer fields that can be set to lie. */
function bplist(
  objects: number[][],
  o: {
    offSize?: number;
    refSize?: number;
    top?: number;
    numObjects?: bigint;
    tableAt?: number;
    offsets?: number[];
  } = {},
): Buffer {
  const offSize = o.offSize ?? 1;
  const head = Buffer.from('bplist00', 'ascii');
  const body: number[] = [];
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(head.length + body.length);
    body.push(...obj);
  }
  const tableAt = head.length + body.length;
  const table = Buffer.alloc(objects.length * offSize);
  for (const [k, off] of (o.offsets ?? offsets).entries()) table.writeUIntBE(off, k * offSize, offSize);
  const trailer = Buffer.alloc(32);
  trailer[6] = offSize;
  trailer[7] = o.refSize ?? 1;
  trailer.writeBigUInt64BE(o.numObjects ?? BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(o.top ?? 0), 16);
  trailer.writeBigUInt64BE(BigInt(o.tableAt ?? tableAt), 24);
  return Buffer.concat([head, Buffer.from(body), table, trailer]);
}
const ASCII_A = [0x51, 0x61]; // the one-character string "a"
const TOO_DEEP = /plist too deep/;
const CORRUPT = /corrupt plist|not a binary plist/;

describe('parseBplist on the committed fixtures', () => {
  it('reads the unsend marker, edit history and rich-link payloads Messages writes', () => {
    assert.deepEqual(parseBplist(PLIST.unsent), { rp: [0] });
    const ec = (parseBplist(PLIST.editGrill) as { ec: { 0: { t: Buffer; d: number }[] } }).ec[0];
    assert.deepEqual(
      ec.map((v) => [decodeAttributedBody(v.t), v.d]),
      [
        ["perfect, I'll bring the girl", 100],
        ["perfect, I'll bring the grill", 160],
      ],
    );
    const link = unarchive(parseBplist(PLIST.linkStays)) as { richLinkMetadata: Record<string, PlistValue> };
    assert.deepEqual(link.richLinkMetadata, { title: 'Lakeside cabin', URL: 'https://www.stays.example/rooms/48213' });
  });

  it('stores a "__proto__" key as plain data, in parseBplist and in unarchive', () => {
    const d = parseBplist(PLIST.protoKey) as Record<string, PlistValue>;
    assert.equal(Object.getPrototypeOf(d), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(d, '__proto__')?.value, { polluted: true });
    assert.equal(d.ok, 'yes');
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    const archived: Record<string, PlistValue> = { $top: { root: new PlistUid(1) }, $objects: ['$null', d] };
    const out = unarchive(archived) as Record<string, PlistValue>;
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(out, '__proto__')?.value, { polluted: true });
  });
});

describe('parseBplist on malformed input', () => {
  const valid = PLIST.unsent;
  const withTrailer = (patch: (t: Buffer) => void) => {
    const b = Buffer.from(valid);
    patch(b.subarray(b.length - 32));
    return b;
  };
  const cases: [string, Buffer, RegExp][] = [
    ['too short to hold a trailer', valid.subarray(0, 39), CORRUPT],
    ['a truncated trailer', valid.subarray(0, valid.length - 10), CORRUPT],
    ['a wrong magic', Buffer.concat([Buffer.from('bplist01'), valid.subarray(8)]), CORRUPT],
    ['offset size 0', withTrailer((t) => (t[6] = 0)), CORRUPT],
    ['offset size 9', withTrailer((t) => (t[6] = 9)), CORRUPT],
    ['ref size 0', withTrailer((t) => (t[7] = 0)), CORRUPT],
    ['a huge object count', withTrailer((t) => t.writeBigUInt64BE(2n ** 64n - 1n, 8)), CORRUPT],
    ['no objects', withTrailer((t) => t.writeBigUInt64BE(0n, 8)), CORRUPT],
    ['a top object past the count', withTrailer((t) => t.writeBigUInt64BE(99n, 16)), CORRUPT],
    ['an offset table past the end', withTrailer((t) => t.writeBigUInt64BE(BigInt(valid.length), 24)), CORRUPT],
    ['an offset table inside the header', withTrailer((t) => t.writeBigUInt64BE(2n, 24)), CORRUPT],
    ['an object offset past the table', bplist([ASCII_A], { offsets: [200] }), CORRUPT],
    ['an object offset inside the header', bplist([ASCII_A], { offsets: [3] }), CORRUPT],
    ['a ref past the object count', bplist([[0xa1, 0x05]]), CORRUPT],
    ['a 16-byte int', bplist([[0x14, ...new Array(16).fill(1)]]), CORRUPT],
    ['an array claiming 2^63 items', bplist([[0xaf, 0x13, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]]), CORRUPT],
    ['a string running into the table', bplist([[0x5f, 0x10, 0xf0, 0x61]]), CORRUPT],
    ['a dict claiming more pairs than fit', bplist([[0xd5, 0x00]]), CORRUPT],
    ['an array that contains itself', bplist([[0xa1, 0x00]]), TOO_DEEP],
    [
      'two arrays that contain each other',
      bplist([
        [0xa1, 0x01],
        [0xa1, 0x00],
      ]),
      TOO_DEEP,
    ],
    [
      'arrays nested 100 deep',
      bplist([...Array.from({ length: 100 }, (_, k) => [0xa1, k + 1]), [0x08]], { refSize: 1 }),
      TOO_DEEP,
    ],
  ];
  for (const [what, blob, err] of cases)
    it(`throws on ${what}`, () => {
      const t0 = performance.now();
      assert.throws(() => parseBplist(blob), err);
      assert.ok(performance.now() - t0 < 100, 'fails fast');
    });

  it('still reads a well-formed hand-built plist', () => {
    assert.deepEqual(parseBplist(bplist([[0xa2, 0x01, 0x02], ASCII_A, [0x10, 0x07]])), ['a', 7]);
  });

  it('unarchive gives up on a graph that is not an archive, and breaks UID cycles', () => {
    assert.equal(unarchive([1, 2] as PlistValue), null);
    assert.deepEqual(unarchive({ $objects: 'nope', $top: {} } as PlistValue), { $objects: 'nope', $top: {} });
    const cyclic: Record<string, PlistValue> = {
      $top: { root: new PlistUid(1) },
      $objects: ['$null', { next: new PlistUid(1), name: 'loop' }],
    };
    assert.deepEqual(unarchive(cyclic), { next: null, name: 'loop' });
  });
});

describe('decodeAttributedBody', () => {
  // Written by Foundation's NSArchiver, the same encoder Messages uses, not by this project's test encoder.
  for (const [name, { text, blob }] of Object.entries(ATTRIBUTED_BODY))
    it(`reads the text of a real ${name} attributedBody`, () => {
      assert.equal(decodeAttributedBody(blob), text);
    });

  it('covers both length forms: one byte under 128, and 0x81 with a 16-bit length above', () => {
    assert.ok(Buffer.byteLength(ATTRIBUTED_BODY.long.text) > 127);
    assert.ok(Buffer.byteLength(ATTRIBUTED_BODY.ascii.text) < 128);
  });

  it('round-trips the test encoder, including the 32-bit length form', () => {
    for (const text of ['hi', 'é'.repeat(100), 'x'.repeat(70_000)])
      assert.equal(decodeAttributedBody(encodeAttributedBody(text)), text);
  });

  it('returns null, never throws, on truncated or foreign blobs', () => {
    const real = ATTRIBUTED_BODY.long.blob;
    const cut = real.indexOf(Buffer.from('The cabin')) + 20;
    for (const blob of [
      null,
      undefined,
      Buffer.alloc(0),
      Buffer.from('short'),
      real.subarray(0, cut),
      Buffer.from('NSString+'.padEnd(40, 'x')),
      Buffer.concat([
        Buffer.from('xxxxxxxxNSString'),
        Buffer.from([0x2b, 0x82, 0xff, 0xff, 0xff, 0x7f]),
        Buffer.alloc(10),
      ]),
      Buffer.alloc(64, 0xff),
    ])
      assert.equal(decodeAttributedBody(blob), null, String(blob?.toString('hex')));
  });
});
