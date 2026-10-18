/** Minimal binary property list reader (bplist00), enough for chat.db's summary and payload blobs. */
import { APPLE_EPOCH_MS } from './appleTime.js';

export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Date
  | Buffer
  | PlistValue[]
  | { [k: string]: PlistValue }
  | PlistUid;
export class PlistUid {
  constructor(public value: number) {}
}

export type PlistDict = { [k: string]: PlistValue };
/** v when it is a dictionary, else undefined. */
export const plistDict = (v: PlistValue | undefined): PlistDict | undefined =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !Buffer.isBuffer(v) &&
  !(v instanceof PlistUid)
    ? v
    : undefined;

const corrupt = (): never => {
  throw new Error('corrupt plist');
};

/** Sets a key without letting "__proto__" swap the object's prototype. */
function setKey(d: { [k: string]: PlistValue }, k: string, v: PlistValue) {
  if (k === '__proto__')
    Object.defineProperty(d, k, { value: v, enumerable: true, writable: true, configurable: true });
  else d[k] = v;
}

/**
 * Blobs come from other people's devices, so every size, offset and count in the trailer and the objects is checked
 * against the buffer before it is used; anything out of range throws 'corrupt plist'.
 */
export function parseBplist(input: Uint8Array): PlistValue {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 40 || buf.toString('ascii', 0, 8) !== 'bplist00') throw new Error('not a binary plist');
  const t = buf.length - 32;
  const offSize = buf[t + 6],
    refSize = buf[t + 7];
  const numObjects = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableAt = Number(buf.readBigUInt64BE(t + 24));
  if (offSize < 1 || offSize > 8 || refSize < 1 || refSize > 8) corrupt();
  if (numObjects < 1 || top >= numObjects || tableAt < 8 || tableAt + numObjects * offSize > t) corrupt();
  const readUInt = (at: number, size: number) => {
    if (at < 0 || at + size > buf.length) corrupt();
    let v = 0;
    for (let k = 0; k < size; k++) v = v * 256 + buf[at + k];
    return v;
  };
  const offsets: number[] = [];
  for (let k = 0; k < numObjects; k++) {
    const off = readUInt(tableAt + k * offSize, offSize);
    if (off < 8 || off >= tableAt) corrupt();
    offsets.push(off);
  }
  const cache = new Map<number, PlistValue>();
  let depth = 0;

  /** [count, start of the payload], for markers whose low nibble is a count (0xf: the count follows as an int). */
  const lengthAt = (at: number, nib: number): [number, number] => {
    if (nib !== 0xf) return [nib, at + 1];
    const m = buf[at + 1];
    if (m >> 4 !== 0x1 || (m & 0xf) > 3) corrupt();
    const size = 1 << (m & 0xf);
    return [readUInt(at + 2, size), at + 2 + size];
  };
  /** Checks that n items of size bytes each fit between start and the offset table. */
  const fits = (start: number, n: number, size: number) => {
    if (start + n * size > tableAt) corrupt();
  };
  const ref = (at: number) => {
    const r = readUInt(at, refSize);
    if (r >= numObjects) corrupt();
    return r;
  };

  const obj = (ref0: number): PlistValue => {
    if (cache.has(ref0)) return cache.get(ref0)!;
    if (++depth > 64) throw new Error('plist too deep');
    const at = offsets[ref0];
    const marker = buf[at];
    const type = marker >> 4,
      nib = marker & 0xf;
    let v: PlistValue;
    switch (type) {
      case 0x0:
        v = nib === 0x8 ? false : nib === 0x9 ? true : null;
        break;
      case 0x1: {
        if (nib > 3) corrupt();
        const size = 1 << nib;
        fits(at + 1, 1, size);
        v = size === 8 ? Number(buf.readBigInt64BE(at + 1)) : readUInt(at + 1, size);
        break;
      }
      case 0x2:
        if (nib !== 2 && nib !== 3) corrupt();
        fits(at + 1, 1, nib === 2 ? 4 : 8);
        v = nib === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
        break;
      case 0x3:
        fits(at + 1, 1, 8);
        v = new Date(APPLE_EPOCH_MS + buf.readDoubleBE(at + 1) * 1000);
        break;
      case 0x4: {
        const [n, s] = lengthAt(at, nib);
        fits(s, n, 1);
        v = buf.subarray(s, s + n);
        break;
      }
      case 0x5: {
        const [n, s] = lengthAt(at, nib);
        fits(s, n, 1);
        v = buf.toString('latin1', s, s + n);
        break;
      }
      case 0x6: {
        const [n, s] = lengthAt(at, nib);
        fits(s, n, 2);
        const u = Buffer.from(buf.subarray(s, s + n * 2));
        u.swap16();
        v = u.toString('utf16le');
        break;
      }
      case 0x8:
        if (nib > 7) corrupt();
        v = new PlistUid(readUInt(at + 1, nib + 1));
        break;
      case 0xa: {
        const [n, s] = lengthAt(at, nib);
        fits(s, n, refSize);
        const arr: PlistValue[] = [];
        for (let k = 0; k < n; k++) arr.push(obj(ref(s + k * refSize)));
        v = arr;
        break;
      }
      case 0xd: {
        const [n, s] = lengthAt(at, nib);
        fits(s, 2 * n, refSize);
        const d: { [k: string]: PlistValue } = {};
        for (let k = 0; k < n; k++) setKey(d, String(obj(ref(s + k * refSize))), obj(ref(s + (n + k) * refSize)));
        v = d;
        break;
      }
      default:
        v = null;
    }
    depth--;
    cache.set(ref0, v);
    return v;
  };
  return obj(top);
}

/** Resolves an NSKeyedArchiver plist into plain values (dicts, arrays, strings, URLs). */
export function unarchive(root: PlistValue): PlistValue {
  if (
    !root ||
    typeof root !== 'object' ||
    Array.isArray(root) ||
    root instanceof Buffer ||
    root instanceof Date ||
    root instanceof PlistUid
  )
    return null;
  const dict = root as { [k: string]: PlistValue };
  const objects = dict.$objects;
  const top = dict.$top as { [k: string]: PlistValue } | undefined;
  if (!Array.isArray(objects) || !top) return root;
  const seen = new Set<number>();
  const resolve = (v: PlistValue): PlistValue => {
    if (v instanceof PlistUid) {
      if (seen.has(v.value)) return null;
      seen.add(v.value);
      const out = resolve(objects[v.value] ?? null);
      seen.delete(v.value);
      return out;
    }
    if (v === '$null') return null;
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object' && !(v instanceof Buffer) && !(v instanceof Date)) {
      const d = v as { [k: string]: PlistValue };
      if ('NS.keys' in d && 'NS.objects' in d) {
        const keys = d['NS.keys'],
          vals = d['NS.objects'];
        if (!Array.isArray(keys) || !Array.isArray(vals)) return null;
        return Object.fromEntries(keys.map((k, i) => [String(resolve(k)), resolve(vals[i] ?? null)]));
      }
      if ('NS.objects' in d) return Array.isArray(d['NS.objects']) ? d['NS.objects'].map(resolve) : null;
      if ('NS.string' in d) return resolve(d['NS.string']);
      if ('NS.relative' in d) {
        const rel = resolve(d['NS.relative']);
        return typeof rel === 'string' ? rel : null;
      }
      const out: { [k: string]: PlistValue } = {};
      for (const [k, x] of Object.entries(d)) if (k !== '$class') setKey(out, k, resolve(x));
      return out;
    }
    return v;
  };
  return resolve(top.root ?? Object.values(top)[0]);
}
