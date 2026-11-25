import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  binary, encode, decode, encodeInto, read, write,
  encodedSize, maxEncodedSize, tryDecode, CborError,
} from '../dist/index.js';

const hex = s => Uint8Array.from(Buffer.from(s.replace(/\s/g, ''), 'hex'));
const equalHex = (value, bytes) => assert.deepEqual(encode(value), hex(bytes));
const bytesOf = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const same = (actual, expected) => {
  if (ArrayBuffer.isView(expected)) {
    assert.equal(Object.prototype.toString.call(actual), Object.prototype.toString.call(expected));
    assert.deepEqual(bytesOf(actual), bytesOf(expected));
  } else assert.ok(Object.is(actual, expected), `${String(actual)} != ${String(expected)}`);
};
const error = code => e => e instanceof CborError && e.code === code;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function roundtrip(value, expected = value) {
  const bytes = encode(value);
  same(decode(bytes), expected);
  assert.equal(bytes.length, encodedSize(value));
  assert.equal(bytes.buffer.byteLength, bytes.length);
  assert.ok(bytes.length <= maxEncodedSize(value));
  for (const capacity of [bytes.length, maxEncodedSize(value)]) {
    const dest = new Uint8Array(capacity + 2).fill(0xaa);
    const view = dest.subarray(1, -1);
    const end = encodeInto(value, view);
    assert.equal(end, bytes.length);
    assert.deepEqual(view.subarray(0, end), bytes);
    assert.equal(dest[0], 0xaa);
    assert.equal(dest.at(-1), 0xaa);
  }
}

test('RFC 8949 golden integer and float vectors', () => {
  const vectors = [
    [0, '00'], [23, '17'], [24, '1818'], [255, '18ff'], [256, '190100'],
    [65535, '19ffff'], [65536, '1a00010000'], [4294967295, '1affffffff'],
    [-1, '20'], [-24, '37'], [-25, '3818'], [-256, '38ff'], [-257, '390100'],
    [-65536, '39ffff'], [-65537, '3a00010000'], [-4294967296, '3affffffff'],
    [1.5, 'fb3ff8000000000000'], [-0, 'fb8000000000000000'],
    [Infinity, 'fb7ff0000000000000'], [-Infinity, 'fbfff0000000000000'],
  ];
  for (const [value, wire] of vectors) {
    equalHex(value, wire);
    same(decode(hex(wire)), value);
    roundtrip(value);
  }
  for (const value of [NaN, Number.MIN_VALUE, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER, 2 ** 32, -(2 ** 32) - 1, Math.PI]) roundtrip(value);
});

test('safe integers beyond 32 bits encode as CBOR integers, not floats', () => {
  const vectors = [
    [2 ** 32, '1b0000000100000000'],
    [1732435200000, '1b000001935d2f4800'],
    [Number.MAX_SAFE_INTEGER, '1b001fffffffffffff'],
    [-(2 ** 32) - 1, '3b0000000100000000'],
    [Number.MIN_SAFE_INTEGER, '3b001ffffffffffffe'],
    // Unsafe integers stay binary64: they cannot be represented exactly.
    [2 ** 53, 'fb4340000000000000'],
    [-(2 ** 53), 'fbc340000000000000'],
  ];
  for (const [value, wire] of vectors) {
    equalHex(value, wire);
    same(decode(hex(wire)), value);
    roundtrip(value);
  }
  assert.deepEqual(decode(encode([2 ** 40, -(2 ** 40), 1.5])), [2 ** 40, -(2 ** 40), 1.5]);
});

test('decoding fresh small buffers: floats, headers and packed arrays', () => {
  // Fresh, never-shared inputs exercise the DataView-free byte paths.
  for (const [wire, value] of [
    ['fb400921fb54442d18', Math.PI], ['fa3fc00000', 1.5], ['f93e00', 1.5],
    ['fbfff0000000000000', -Infinity], ['1a12345678', 0x12345678],
    ['1affffffff', 0xffffffff], ['19abcd', 0xabcd], ['3affffffff', -4294967296],
  ]) same(decode(hex(wire)), value);
  same(decode(hex('fa7fc00000')), NaN);
  const array = decode(encode([1, 2.5, 'x', 2 ** 33]));
  assert.deepEqual(array, [1, 2.5, 'x', 2 ** 33]);
  assert.equal(Object.keys(array).length, 4);
  assert.ok(0 in array && 3 in array);
});

test('float arrays decode identically via byte and DataView paths', () => {
  const small = [1.5, -0, NaN, Math.PI];            // 37 bytes: stays on the byte path
  const large = Array.from({ length: 40 }, (_, i) => i % 3 ? i + 0.25 : -i - 0.5);
  large[7] = -0; large[11] = NaN; large[13] = Infinity; large[17] = 2 ** 40;
  for (const values of [small, large]) {
    const wire = encode(values);
    const check = got => {
      assert.equal(got.length, values.length);
      values.forEach((v, i) => same(got[i], v));
    };
    check(decode(wire));
    // Nonzero byteOffset inside a larger buffer exercises the lazy DataView offset.
    const host = new Uint8Array(wire.length + 13);
    host.set(wire, 5);
    check(decode(host.subarray(5, 5 + wire.length)));
  }
});

test('non-preferred widths, safe uint64 and negative int64, binary16 and binary32', () => {
  const vectors = [
    ['1800', 0], ['190017', 23], ['1b0000000100000000', 2 ** 32],
    ['1b001fffffffffffff', Number.MAX_SAFE_INTEGER], ['3b001ffffffffffffe', Number.MIN_SAFE_INTEGER],
    ['f90000', 0], ['f98000', -0], ['f90001', 2 ** -24], ['f903ff', 1023 * 2 ** -24],
    ['f90400', 2 ** -14], ['f93e00', 1.5], ['f97bff', 65504], ['f97c00', Infinity],
    ['f9fc00', -Infinity], ['f97e00', NaN], ['fa3fc00000', 1.5], ['fa80000000', -0],
  ];
  for (const [wire, value] of vectors) same(decode(hex(wire)), value);
  // Beyond the safe range: bigint rather than an error.
  assert.equal(decode(hex('1b0020000000000000')), 2n ** 53n);
  assert.equal(decode(hex('3b001fffffffffffff')), -(2n ** 53n));
});

test('golden text vectors and UTF-8 header boundaries', () => {
  for (const [value, wire] of [['', '60'], ['a', '6161'], ['IETF', '6449455446'],
    ['ü', '62c3bc'], ['水', '63e6b0b4'], ['😀', '64f09f9880'], ['\ufeff', '63efbbbf']]) equalHex(value, wire);
  for (const n of [0, 1, 7, 15, 16, 17, 23, 24, 31, 63, 64, 65, 85, 127, 128, 255, 256, 21845, 21846, 65535, 65536]) {
    for (const char of ['a', 'é', '水', '😀']) roundtrip(char.repeat(n));
  }
  for (const s of ['\ud800', '\udc00', 'a\ud800b', '\ud800\ud800\udc00', '\udc00'.repeat(70), '\ufeffabc', 'a\0b']) {
    const normalized = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(s));
    roundtrip(s, normalized);
  }
});

test('malformed UTF-8 is rejected or replaced by explicit policy', () => {
  for (const wire of ['6180', '62c080', '63eda080', '64f4908080', '62e282', '63e228a1']) {
    const bytes = hex(wire);
    assert.throws(() => decode(bytes), error('invalid-utf8'));
    same(decode(bytes, { invalidUtf8: 'replace' }), new TextDecoder().decode(bytes.subarray(1)));
  }
  same(decode(hex('63efbbbf')), '\ufeff');
});

const typedCases = [
  new Uint8Array([0, 255, 42]), new Uint8ClampedArray([0, 255, 1]),
  new Uint16Array([1, 65535, 0]), new Uint32Array([1, 0xffffffff, 0]),
  new BigUint64Array([0n, (1n << 64n) - 1n]), new Int8Array([-128, 127, 0]),
  new Int16Array([-32768, 32767, 0]), new Int32Array([-2147483648, 2147483647, 0]),
  new BigInt64Array([-(1n << 63n), (1n << 63n) - 1n]),
  new Float32Array([-0, NaN, Infinity, -Infinity, Math.PI]), new Float64Array([-0, NaN, Infinity, -Infinity, Math.PI]),
];

test('all typed array kinds, empty arrays, subviews, copy and borrow fallback', () => {
  for (const a of typedCases) {
    roundtrip(a);
    roundtrip(a.subarray(1));
    roundtrip(a.subarray(0, 0));
    const encoded = encode(a);
    const owned = decode(encoded);
    assert.notEqual(owned.buffer, encoded.buffer);
    same(decode(encoded, { binaryOwnership: 'borrow' }), a);
  }
  equalHex(new Uint8Array([1, 2, 3]), '43010203');
  same(decode(hex('d84043010203')), new Uint8Array([1, 2, 3]));
  equalHex(new Int8Array([-1, 1]), 'd84842ff01');
  equalHex(new Uint16Array([0x1234]), littleEndian ? 'd845423412' : 'd841421234');
});

test('RFC 8746 both endian forms preserve raw element bits', () => {
  const vectors = [
    ['d841441234abcd', 'd845443412cdab', new Uint16Array([0x1234, 0xabcd])],
    ['d8424401020304', 'd8464404030201', new Uint32Array([0x01020304])],
    ['d843480102030405060708', 'd847480807060504030201', new BigUint64Array([0x0102030405060708n])],
    ['d84942fffe', 'd84d42feff', new Int16Array([-2])],
    ['d84a44fffffffe', 'd84e44feffffff', new Int32Array([-2])],
    ['d84b48fffffffffffffffe', 'd84f48feffffffffffffff', new BigInt64Array([-2n])],
    ['d851443fc00000', 'd855440000c03f', new Float32Array([1.5])],
    ['d852483ff8000000000000', 'd85648000000000000f83f', new Float64Array([1.5])],
  ];
  for (const [be, le, expected] of vectors) {
    same(decode(hex(be)), expected);
    same(decode(hex(le)), expected);
  }
  const nan = new Float32Array(1);
  new DataView(nan.buffer).setUint32(0, 0x7fc01234, littleEndian);
  roundtrip(nan);
  same(decode(hex('d851447fc01234')), nan);
  same(decode(hex('d855443412c07f')), nan);
});

test('borrow mode aliases aligned payloads only; copy mode is independent', () => {
  for (const a of typedCases) {
    const encoded = encode(a);
    const header = encoded.length - a.byteLength;
    const width = a.BYTES_PER_ELEMENT;
    for (let offset = 0; offset < width + 1; offset++) {
      const backing = new Uint8Array(offset + encoded.length + 2);
      const source = backing.subarray(offset, offset + encoded.length);
      source.set(encoded);
      const borrowed = decode(source, { binaryOwnership: 'borrow' });
      same(borrowed, a);
      assert.equal(borrowed.buffer === backing.buffer, (offset + header) % width === 0);
      assert.notEqual(decode(source).buffer, backing.buffer);
    }
  }
  const input = hex('43010203');
  const result = decode(input, { binaryOwnership: 'borrow' });
  result[0] = 99;
  assert.equal(input[1], 99);
});

test('sequence cursors, offset views and overlapping binary writes', () => {
  const backing = new Uint8Array(128).fill(0xff);
  const b = binary(backing.subarray(7, 110));
  const values = [42, 'é😀', -0, new Uint16Array([1, 2]), new Int8Array([-1])];
  let pos = 3;
  for (const v of values) pos = write(b, pos, v);
  const last = pos;
  pos = 3;
  for (const v of values) {
    const [actual, next] = read(b, pos);
    same(actual, v);
    pos = next;
  }
  assert.equal(pos, last);
  assert.equal(backing[6], 0xff);
  assert.equal(backing[7 + last], 0xff);
  const overlap = new Uint8Array([1, 2, 3, 4, 5, 0, 0, 0]);
  const end = encodeInto(overlap.subarray(0, 5), overlap);
  assert.deepEqual(decode(overlap.subarray(0, end)), new Uint8Array([1, 2, 3, 4, 5]));
});

test('every truncation point fails without reading outside the supplied view', () => {
  for (const value of [0, 256, -4294967296, Math.PI, 'é'.repeat(40), ...typedCases]) {
    const all = encode(value);
    for (let i = 0; i < all.length; i++) {
      assert.throws(() => decode(all.subarray(0, i)), error('truncated'));
    }
  }
});

test('invalid headers, lengths, unsupported values, and trailing data', () => {
  const cases = [
    ['1c', 'invalid-header'], ['7f', 'truncated'], ['5f', 'truncated'],
    ['d84541ff', 'invalid-length'], ['d84560', 'invalid-header'], ['c000', 'invalid-tag-content'],
    ['f81f', 'invalid-header'], ['fc', 'invalid-header'], ['ff', 'invalid-header'], ['0000', 'trailing-data'],
    ['5affffffff', 'truncated'], ['7b001fffffffffffff', 'truncated'],
  ];
  for (const [wire, code] of cases) {
    assert.throws(() => decode(hex(wire)), error(code));
    const result = tryDecode(hex(wire));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
  assert.deepEqual(tryDecode(hex('182a')), { ok: true, value: 42 });
  for (const value of [new Set(), [new WeakMap()], { a: Symbol('s') }, () => 1, new DataView(new ArrayBuffer(8)), new ArrayBuffer(8)]) {
    assert.throws(() => encode(value), error('unsupported-type'));
  }
  for (const offset of [-1, 1.5, NaN, Infinity, 5]) {
    assert.throws(() => encodeInto(0, new Uint8Array(4), offset), error('invalid-offset'));
    assert.throws(() => read(binary(new Uint8Array(4)), offset), error('invalid-offset'));
  }
  assert.throws(() => decode(new Int8Array([0])), error('invalid-buffer'));
});

test('insufficient capacity leaves destination unchanged; outputs never alias', () => {
  for (const value of [1, Math.PI, 'é'.repeat(24), new Float64Array([1, 2])]) {
    const dest = new Uint8Array(encodedSize(value) - 1).fill(0xcc);
    assert.throws(() => encodeInto(value, dest), error('capacity'));
    assert.ok(dest.every(x => x === 0xcc));
  }
  const first = encode('first');
  for (let i = 0; i < 100; i++) encode('second'.repeat(i));
  assert.equal(decode(first), 'first');
  const foreign = vm.runInNewContext('new Uint16Array([1, 2, 3])');
  same(decode(encode(foreign)), new Uint16Array([1, 2, 3]));
  same(decode(vm.runInNewContext('new Uint8Array([24, 42])')), 42);
});

test('seeded property checks: random binary64 bit patterns and UTF-16 strings', () => {
  let seed = 0xdeadbeef;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const dv = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 5000; i++) {
    dv.setUint32(0, rng()); dv.setUint32(4, rng());
    roundtrip(dv.getFloat64(0));
    roundtrip(rng()); roundtrip(-rng());
    let s = '';
    const n = rng() % 100;
    for (let j = 0; j < n; j++) s += String.fromCharCode(rng() & 0xffff);
    const normalized = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(s));
    roundtrip(s, normalized);
  }
});

test('random malformed byte strings only yield values or typed errors', () => {
  let seed = 12345;
  const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 10000; i++) {
    const data = Uint8Array.from({ length: rng() % 32 }, () => rng() >>> 24);
    const result = tryDecode(data);
    if (!result.ok) assert.ok(result.error instanceof CborError);
  }
});

test('short text decoding matches TextDecoder exactly (strict and replace)', () => {
  const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const lenient = new TextDecoder('utf-8', { ignoreBOM: true });
  // Bias toward UTF-8 structure: ASCII, continuation, every lead-byte class.
  const pool = [0x41, 0x7f, 0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xa0, 0xed, 0x9f,
    0xef, 0xf0, 0x90, 0xf4, 0x8f, 0xf5, 0xff, 0xe6, 0xb0, 0xb4, 0x9f, 0x98, 0x80];
  let seed = 12345;
  const random = n => (seed = (seed * 1103515245 + 12345) >>> 0) % n;
  for (let i = 0; i < 20000; i++) {
    const length = random(40);
    const payload = Uint8Array.from({ length }, () => random(4) ? pool[random(pool.length)] : random(256));
    const wire = new Uint8Array([0x78, length, ...payload]);
    let expected;
    try { expected = strict.decode(payload); } catch { expected = undefined; }
    if (expected === undefined) assert.throws(() => decode(wire), error('invalid-utf8'));
    else assert.equal(decode(wire), expected);
    assert.equal(decode(wire, { invalidUtf8: 'replace' }), lenient.decode(payload));
  }
});

test('owned encoding stays correct when an exotic input re-enters encode()', () => {
  const inner = ['inner', 'x'.repeat(100)];
  const values = ['outer', 'y'.repeat(70), 0];
  let nested;
  Object.defineProperty(values, 2, { get() { nested = encode(inner); return 7; } });
  const bytes = encode(values);
  assert.deepEqual(decode(bytes), ['outer', 'y'.repeat(70), 7]);
  assert.deepEqual(decode(nested), inner);
  assert.equal(bytes.buffer.byteLength, bytes.length);
});

test('false, true and null: wire format, arrays, sequences and pooling', () => {
  for (const [value, wire] of [[false, 'f4'], [true, 'f5'], [null, 'f6']]) {
    equalHex(value, wire);
    same(decode(hex(wire)), value);
    roundtrip(value);
  }
  const mixed = [true, null, false, 0, 'x', 1.5, null];
  equalHex(mixed, '87f5f6f400617' + '8fb3ff8000000000000f6');
  assert.deepEqual(decode(encode(mixed)), mixed);
  // Long arrays take the staging path, and a fresh small buffer the byte path.
  const long = Array.from({ length: 300 }, (_, i) => [true, false, null, i, `s${i}`][i % 5]);
  assert.deepEqual(decode(encode(long)), long);
  // Sequence reads advance exactly one byte per simple value.
  const seq = binary(hex('f5f6f4'));
  assert.deepEqual(read(seq, 0), [true, 1]);
  assert.deepEqual(read(seq, 1), [null, 2]);
  assert.deepEqual(read(seq, 2), [false, 3]);
  assert.equal(encodedSize(null), 1);
  assert.equal(maxEncodedSize(true), 1);
  // Capacity errors leave the destination untouched.
  const dest = new Uint8Array(0);
  assert.throws(() => encodeInto(true, dest), error('capacity'));
});
