import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binary, encode, decode, encodeInto, read, encodedSize, maxEncodedSize,
  createSlabEncoder, tryDecode, CborError,
} from '../dist/index.js';

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = 'true';
let reference;
try { reference = await import('cbor-x'); }
catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }

const hex = s => Uint8Array.from(Buffer.from(s.replace(/\s/g, ''), 'hex'));
const toHex = b => Buffer.from(b).toString('hex');
const error = code => e => e instanceof CborError && e.code === code;

function roundtrip(value, expected = value) {
  const bytes = encode(value);
  assert.deepEqual(decode(bytes), expected);
  assert.equal(bytes.length, encodedSize(value));
  assert.ok(bytes.length <= maxEncodedSize(value));
  assert.equal(bytes.buffer.byteLength, bytes.length);
  const dest = new Uint8Array(bytes.length + 2).fill(0xaa);
  assert.equal(encodeInto(value, dest, 1), bytes.length + 1);
  assert.deepEqual(dest.subarray(1, -1), bytes);
  assert.equal(dest[0], 0xaa);
  assert.equal(dest.at(-1), 0xaa);
}

test('maps: wire format with preferred headers', () => {
  for (const [value, wire] of [
    [{}, 'a0'],
    [{ a: 1 }, 'a1616101'],
    [{ a: [1, { b: null }] }, 'a161618201a16162f6'],
    [{ '': true, 'é': 'x' }, 'a260f562c3a96178'],
  ]) {
    assert.equal(toHex(encode(value)), wire);
    assert.deepEqual(decode(hex(wire)), value);
    roundtrip(value);
  }
  for (const n of [23, 24, 255, 256]) {
    const obj = Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    const bytes = encode(obj);
    assert.equal(bytes[0], n < 24 ? 0xa0 | n : n < 256 ? 0xb8 : 0xb9);
    roundtrip(obj);
  }
});

test('nested values of every kind round trip', () => {
  const value = {
    id: 2 ** 40, name: 'é水😀', ok: true, none: null, ratio: -0, nan: NaN,
    list: [1, 'two', [3, [4, { five: 5 }]], false],
    bytes: new Uint8Array([1, 2, 3]), floats: new Float64Array([Math.PI, -0]),
    deep: { a: { b: { c: { d: [] } } } },
  };
  roundtrip(value);
  assert.deepEqual(decode(encode([[], {}, [[[]]], [{}]])), [[], {}, [[[]]], [{}]]);
});

test('undefined properties are omitted; undefined elements encode as f7', () => {
  assert.equal(toHex(encode({ a: 1, b: undefined })), 'a1616101');
  assert.deepEqual(decode(encode({ a: undefined, b: { c: undefined } })), { b: {} });
  assert.equal(encodedSize({ a: 1, b: undefined }), 4);
  // 24 keys with one undefined: header shrinks to the 1-byte form.
  const obj = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`k${i}`, i === 5 ? undefined : i]));
  const bytes = encode(obj);
  assert.equal(bytes[0], 0xa0 | 23);
  assert.equal(bytes.length, encodedSize(obj));
  const dest = new Uint8Array(bytes.length);
  assert.equal(encodeInto(obj, dest), bytes.length);
  assert.equal(toHex(encode([1, undefined])), '8201f7');
  assert.equal(toHex(encode(new Array(2))), '82f7f7'); // holes are undefined
  assert.deepEqual(decode(encode({ a: [undefined] })), { a: [undefined] });
});

test('only plain objects encode', () => {
  const bare = Object.create(null);
  bare.x = 1;
  roundtrip(bare, { x: 1 });
  class Point { constructor() { this.x = 1; } }
  for (const v of [new Point(), new Set(), /x/, new String('s'),
    new ArrayBuffer(4), new DataView(new ArrayBuffer(4)), () => 1, Symbol('s')]) {
    assert.throws(() => encode(v), error('unsupported-type'));
    assert.throws(() => encode({ v }), error('unsupported-type'));
    assert.throws(() => encodedSize({ v }), error('unsupported-type'));
  }
  assert.equal(toHex(encode(undefined)), 'f7');
  // Symbol keys are ignored, like JSON.
  assert.deepEqual(decode(encode({ a: 1, [Symbol('s')]: 2 })), { a: 1 });
});

test('__proto__ decodes as an own data property: no pollution, no renaming', () => {
  const wire = hex('a1695f5f70726f746f5f5fa1667069776e656401');
  const obj = decode(wire);
  assert.equal(Object.getPrototypeOf(obj), Object.prototype);
  assert.ok(Object.hasOwn(obj, '__proto__'));
  assert.deepEqual(Object.getOwnPropertyDescriptor(obj, '__proto__').value, { piwned: 1 });
  assert.equal({}.piwned, undefined);
  assert.equal(obj.piwned, undefined);
  // Round trip of an own __proto__ property (as JSON.parse creates).
  const parsed = JSON.parse('{"__proto__": {"x": 1}, "y": 2}');
  assert.equal(toHex(encode(parsed)), toHex(encode(decode(encode(parsed)))));
  assert.deepEqual(Object.keys(decode(encode(parsed))), ['__proto__', 'y']);
});

test('duplicate keys are rejected by default; last-wins on request', () => {
  const wire = hex('a2616101616102');
  assert.throws(() => decode(wire), error('duplicate-key'));
  assert.equal(tryDecode(wire).error.offset, 0); // the map's header
  assert.deepEqual(decode(wire, { duplicateKeys: 'last-wins' }), { a: 2 });
  assert.throws(() => decode(hex('a2695f5f70726f746f5f5f01695f5f70726f746f5f5f02')), error('duplicate-key'));
});

test("maps: 'object' mode requires text keys; 'auto' falls back to Map", () => {
  for (const wire of ['a10102', 'a1f600', 'a1410000', 'a18000', 'a1a000']) {
    assert.throws(() => decode(hex(wire), { maps: 'object' }), error('unsupported-type'));
    assert.ok(decode(hex(wire)) instanceof Map);
  }
});

test('depth limit: decode, encode and cycles', () => {
  const nest = n => { let v = 0; for (let i = 0; i < n; i++) v = [v]; return v; };
  assert.deepEqual(decode(encode(nest(128))), nest(128));
  assert.throws(() => encode(nest(129)), error('depth-limit'));
  const deep = new Uint8Array(200).fill(0x81);
  assert.throws(() => decode(deep), error('depth-limit'));
  assert.throws(() => decode(encode(nest(10)), { maxDepth: 9 }), error('depth-limit'));
  assert.deepEqual(decode(encode(nest(10)), { maxDepth: 10 }), nest(10));
  assert.deepEqual(decode(encode(5), { maxDepth: 0 }), 5);
  assert.throws(() => decode(encode([]), { maxDepth: 0 }), error('depth-limit'));
  for (const n of [-1, 1.5, NaN]) assert.throws(() => decode(hex('80'), { maxDepth: n }), error('depth-limit'));
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => encode(cyclic), error('depth-limit'));
  assert.throws(() => encodedSize(cyclic), error('depth-limit'));
  const list = [1];
  list.push(list);
  assert.throws(() => encodeInto(list, new Uint8Array(64)), error('depth-limit'));
  // Hostile depth never escapes as a RangeError.
  assert.equal(tryDecode(new Uint8Array(100000).fill(0x81)).error.code, 'depth-limit');
});

test('map and allocation limits are checked before allocating', () => {
  assert.throws(() => decode(encode({ a: 1, b: 2 }), { maxMapEntries: 1 }), error('map-limit'));
  assert.deepEqual(decode(encode({ a: 1 }), { maxMapEntries: 1 }), { a: 1 });
  for (const n of [-1, Infinity]) assert.throws(() => decode(hex('a0'), { maxMapEntries: n }), error('map-limit'));
  assert.throws(() => decode(hex('ba00010000')), error('truncated'));
  // Nested headers that each fit the remaining bytes but together declare
  // far more items than the input holds: rejected by the allocation budget.
  const levels = 100;
  const size = 3 * levels + 4000;
  const chain = new Uint8Array(size); // zero padding = valid integer elements
  let p = 0;
  for (let i = 0; i < levels; i++) {
    const declared = size - p - 3;
    chain[p++] = 0x99; chain[p++] = declared >>> 8; chain[p++] = declared & 255;
  }
  // Fails at the second header (offset 3), before allocating its array.
  assert.equal(tryDecode(chain).error.offset, 3);
  assert.equal(tryDecode(chain).error.code, 'truncated');
});

test('capacity errors never partially write, for nested values too', () => {
  const value = { list: ['é'.repeat(50), { n: 1.5 }], s: 'x'.repeat(30) };
  const bytes = encode(value);
  for (const capacity of [0, 1, bytes.length - 1]) {
    const dest = new Uint8Array(capacity).fill(0xcc);
    assert.throws(() => encodeInto(value, dest), error('capacity'));
    assert.ok(dest.every(x => x === 0xcc));
  }
});

test('sequences and slabs carry objects', () => {
  const values = [{ a: 1 }, [{ b: [2] }], 'x', { c: { d: null } }];
  const parts = values.map(encode);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const part of parts) { all.set(part, o); o += part.length; }
  const buffer = binary(all);
  let p = 0;
  for (const value of values) {
    const [got, next] = read(buffer, p);
    assert.deepEqual(got, value);
    p = next;
  }
  assert.equal(p, all.length);
  const pooled = createSlabEncoder({ slabSize: 1024 });
  const outputs = values.map(pooled);
  assert.equal(outputs[0].buffer, outputs[1].buffer);
  outputs.forEach((bytes, i) => assert.deepEqual(decode(bytes), values[i]));
  const big = { data: 'x'.repeat(2000) };
  assert.equal(pooled(big).buffer.byteLength, encodedSize(big));
});

test('key cache: correct under collisions, Unicode and both UTF-8 modes', () => {
  // Many distinct short keys force slot reuse; every decode must still be exact.
  const keys = Array.from({ length: 5000 }, (_, i) => (i * 7919).toString(36) + (i % 3 ? 'é' : ''));
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < keys.length; i += 50) {
      const obj = Object.fromEntries(keys.slice(i, i + 50).map((k, j) => [k, j]));
      assert.deepEqual(decode(encode(obj)), obj);
    }
  }
  // An invalid key decoded leniently must not be served from cache to a strict decode.
  const wire = hex('a161ff01');
  assert.deepEqual(decode(wire, { invalidUtf8: 'replace' }), { '�': 1 });
  assert.throws(() => decode(wire), error('invalid-utf8'));
  assert.deepEqual(decode(hex('a16001')), { '': 1 });
});

// Deterministic random trees, avoiding values cbor-x maps differently (-0,
// __proto__, typed arrays other than Uint8Array).
function makeRandom(seed) {
  const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const int = n => Math.floor(rand() * n);
  const chars = ['a', 'b', 'c', 'x', 'y', 'z', 'é', '水', '😀', '_'];
  const text = () => Array.from({ length: int(12) }, () => chars[int(chars.length)]).join('');
  const tree = depth => {
    const r = int(depth > 4 ? 6 : 9);
    switch (r) {
      case 0: return int(1000) - 500;
      case 1: return rand() * 1e6;
      case 2: return text();
      case 3: return [true, false, null][int(3)];
      case 4: return 2 ** 40 + int(1000);
      case 5: return int(2) ? Number.MAX_SAFE_INTEGER : -(2 ** 33);
      case 6: case 7: return Array.from({ length: int(6) }, () => tree(depth + 1));
      default: return Object.fromEntries(Array.from({ length: int(6) }, () => [text() || 'k', tree(depth + 1)]));
    }
  };
  return tree;
}

test('seeded random trees round trip (owned, prepared, pooled)', () => {
  const tree = makeRandom(0x5eed);
  const pooled = createSlabEncoder({ slabSize: 8192 });
  for (let i = 0; i < 2000; i++) {
    const value = tree(0);
    roundtrip(value);
    assert.deepEqual(decode(pooled(value)), value);
  }
});

test('bidirectional cbor-x interoperability on random trees', { skip: !reference }, () => {
  const encoder = new reference.Encoder({ useRecords: false, variableMapSize: true });
  // cbor-x decodes 64-bit integers as BigInt unless asked otherwise.
  const decoder = new reference.Decoder({ useRecords: false, int64AsNumber: true });
  const tree = makeRandom(0xc0ffee);
  for (let i = 0; i < 2000; i++) {
    const value = tree(0);
    assert.deepEqual(decode(encoder.encode(value)), value);
    assert.deepEqual(decoder.decode(encode(value)), value);
  }
});

test('random container-heavy bytes only yield values or typed errors', () => {
  let seed = 99;
  const rand = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  const pool = [0x80, 0x81, 0x82, 0x98, 0xa0, 0xa1, 0xa2, 0xb8, 0x60, 0x61, 0x62, 0x01, 0x18, 0xf4, 0xf6, 0xfb, 0x40, 0xd8, 0x9f, 0xbf, 0xff];
  for (let i = 0; i < 20000; i++) {
    const bytes = Uint8Array.from({ length: 1 + rand(30) }, () => rand(3) ? pool[rand(pool.length)] : rand(256));
    try { decode(bytes); }
    catch (e) { assert.ok(e instanceof CborError, `${toHex(bytes)}: ${e}`); }
  }
});

test('a polluted Object.prototype never leaks keys into encoded objects', () => {
  Object.prototype.polluted = 'leak';
  try {
    const value = { a: 1, nested: { b: [{ c: 2 }] } };
    const expected = '{"a":1,"nested":{"b":[{"c":2}]}}';
    const decoded = decode(encode(value));
    assert.equal(JSON.stringify(decoded), expected);
    assert.deepEqual(Object.keys(decoded.nested.b[0]), ['c']);
    assert.equal(encodedSize(value), encode(value).length);
  } finally {
    delete Object.prototype.polluted;
  }
});
