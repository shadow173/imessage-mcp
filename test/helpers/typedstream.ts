/** Builds a minimal attributedBody (typedstream NSAttributedString) that decodeAttributedBody reads back. */
export function encodeAttributedBody(text: string): Buffer {
  const utf8 = Buffer.from(text, 'utf8');
  const len =
    utf8.length < 0x80
      ? Buffer.from([utf8.length])
      : utf8.length < 0x10000
        ? Buffer.concat([
            Buffer.from([0x81]),
            (() => {
              const x = Buffer.alloc(2);
              x.writeUInt16LE(utf8.length);
              return x;
            })(),
          ])
        : Buffer.concat([
            Buffer.from([0x82]),
            (() => {
              const x = Buffer.alloc(4);
              x.writeUInt32LE(utf8.length);
              return x;
            })(),
          ]);
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from('streamtyped'),
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from('NSAttributedString'),
    Buffer.from([0x00, 0x84, 0x84, 0x08]),
    Buffer.from('NSObject'),
    Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08]),
    Buffer.from('NSString'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    len,
    utf8,
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49]),
  ]);
}
