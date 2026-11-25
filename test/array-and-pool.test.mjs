import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { binary, encode, decode, read, readWhole, write, encodeInto,
  encodedSize, maxEncodedSize, createSlabEncoder, CborError } from '../dist/index.js';
const hex = s => Uint8Array.from(Buffer.from(s, 'hex'));
const error = code => e => e instanceof CborError && e.code === code;
const normalize = s => new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(s));

function check(value, expected = value) {
  const bytes = encode(value);
  assert.equal(bytes.length, encodedSize(value));
  assert.equal(bytes.buffer.byteLength, bytes.length);
  assert.deepEqual(decode(bytes), expected);
  assert.deepEqual(readWhole(binary(bytes)), expected);
  for (const cap of [encodedSize(value), maxEncodedSize(value)]) {
    const dest = new Uint8Array(cap + 4).fill(0xcc);
    const b = binary(dest.subarray(1, -1));
    const end = write(b, 2, value);
    assert.equal(end, 2 + bytes.length);
    assert.deepEqual(b.bytes.subarray(2, end), bytes);
    assert.deepEqual(read(b, 2), [expected, end]);
    assert.equal(dest[0], 0xcc);
    assert.equal(dest[2], 0xcc);
    assert.ok(dest.subarray(1 + end).every(x => x === 0xcc));
  }
}

test('flat arrays: golden wire, mixed types, special numbers, cross-realm and frozen arrays', () => {
  for (const [value, wire] of [[[], '80'], [[1, 2, 3], '83010203'], [[1, 'a', -1], '8301616120'],
    [['', 24, 1.5], '83601818fb3ff8000000000000']]) {
    assert.deepEqual(encode(value), hex(wire));
    check(value);
  }
  check([0, -0, NaN, Infinity, -Infinity, Math.PI, Number.MAX_SAFE_INTEGER, 'é水😀', '\ufeff', '\ud800'],
        [0, -0, NaN, Infinity, -Infinity, Math.PI, Number.MAX_SAFE_INTEGER, 'é水😀', '\ufeff', '\ufffd']);
  check(Object.freeze(['a', 1]));
  check(vm.runInNewContext('[1,"hello"]'), [1, 'hello']);
  assert.deepEqual(decode(hex('9802016178')), [1, 'x']);
  assert.deepEqual(decode(hex('83f93e00fa3fc000001b0000000100000000')), [1.5, 1.5, 2 ** 32]);
});

test('array header thresholds, empty arrays, and long UTF-8 strings', () => {
  for (const n of [0, 1, 23, 24, 255, 256, 65535, 65536]) check(Array.from({ length: n }, (_, i) => i % 25));
  check(['é'.repeat(128), 'a'.repeat(65536), '😀'.repeat(8192), 'x']);
});

test('arrays reject malformed/unsupported elements and capacity errors atomically', () => {
  class Point { constructor() { this.x = 1; } }
  for (const v of [[new Set()], [new Point()], [Symbol('s')], [() => 1], [[1, [new WeakMap()]]]]) {
    const dest = new Uint8Array(128).fill(0xcc);
    assert.throws(() => encode(v), error('unsupported-type'));
    assert.throws(() => encodeInto(v, dest), error('unsupported-type'));
    assert.ok(dest.every(x => x === 0xcc));
  }
  const value = [1, 'é'.repeat(200), Math.PI, 'x'];
  const all = encode(value);
  for (let i = 0; i < all.length; i++) assert.throws(() => decode(all.subarray(0, i)), error('truncated'));
  const dest = new Uint8Array(all.length - 1).fill(0xcc);
  assert.throws(() => encodeInto(value, dest), error('capacity'));
  assert.ok(dest.every(x => x === 0xcc));
  assert.deepEqual(decode(hex('8180')), [[]]);
  assert.deepEqual(decode(hex('8140')), [new Uint8Array(0)]);
  assert.deepEqual(decode(hex('81d84040')), [new Uint8Array(0)]);
  for (const [wire, code] of [['81c000','invalid-tag-content'], ['81f81f','invalid-header'],
    ['81ff','invalid-header'], ['816180','invalid-utf8'], ['9f01','truncated'], ['9a00100000','array-limit'],
    ['99010001','truncated'], ['8000','trailing-data']]) assert.throws(() => decode(hex(wire)), error(code));
  assert.deepEqual(decode(hex('816180'), { invalidUtf8: 'replace' }), ['\ufffd']);
});

test('array allocation limit checked before allocating', () => {
  assert.deepEqual(decode(encode([]), { maxArrayLength: 0 }), []);
  assert.deepEqual(decode(encode([1, 2]), { maxArrayLength: 2 }), [1, 2]);
  assert.throws(() => decode(encode([1, 2]), { maxArrayLength: 1 }), error('array-limit'));
  for (const n of [-1, NaN, Infinity, 1.5]) assert.throws(() => decode(hex('80'), { maxArrayLength: n }), error('array-limit'));
  assert.throws(() => decode(hex('9a00010000'), { maxArrayLength: 100000 }), error('truncated'));
});

test('short ASCII word reads respect view bounds and fall back at every Unicode position', () => {
  for (let n = 0; n <= 80; n++) {
    const ascii = Array.from({ length: n }, (_, i) => String.fromCharCode((i * 37) & 127)).join('');
    for (let align = 0; align < 4; align++) {
      const bytes = encode(ascii);
      const view = new Uint8Array(align + bytes.length + 5).subarray(align, align + bytes.length);
      view.set(bytes);
      assert.equal(decode(view), ascii);
    }
    for (let i = 0; i < n; i++) {
      const s = ascii.slice(0, i) + 'é' + ascii.slice(i + 1);
      assert.equal(decode(encode(s)), s);
    }
  }
  for (let pos = 0; pos < 32; pos++) {
    const a = encode('x'.repeat(32));
    a[2 + pos] = 0xff;
    assert.throws(() => decode(a), error('invalid-utf8'));
    assert.equal(decode(a, { invalidUtf8: 'replace' }), 'x'.repeat(pos) + '\ufffd' + 'x'.repeat(31 - pos));
  }
});

test('slabs are lazy, disjoint and stable through rollover; large values bypass pool', () => {
  const pooled = createSlabEncoder({ slabSize: 64, maxPooledValueSize: 32 });
  const a = pooled(1), b = pooled('hello');
  assert.equal(a.buffer, b.buffer);
  assert.equal(a.byteOffset + a.byteLength, b.byteOffset);
  const snapshot = [...a, ...b];
  const large = pooled('x'.repeat(100));
  assert.equal(large.buffer.byteLength, large.length);
  assert.notEqual(large.buffer, a.buffer);
  const retained = [a, b];
  for (let i = 0; i < 150; i++) retained.push(pooled([i, 'a']));
  assert.notEqual(retained.at(-1).buffer, a.buffer);
  assert.deepEqual([...a, ...b], snapshot);
  for (let i = 2; i < retained.length; i++) assert.deepEqual(decode(retained[i]), [i - 2, 'a']);
  const other = createSlabEncoder({ slabSize: 64 })(1);
  assert.notEqual(other.buffer, a.buffer);
  a[0] = 3;
  assert.equal(decode(a), 3);
  assert.equal(decode(b), 'hello');
  assert.throws(() => pooled([new Set()]), error('unsupported-type'));
  assert.deepEqual(decode(pooled([{ a: 1 }])), [{ a: 1 }]);
  assert.deepEqual(decode(pooled(['ok', 1])), ['ok', 1]);
  assert.equal(createSlabEncoder({ slabSize: 64, maxPooledValueSize: 0 })(1).buffer.byteLength, 1);
  for (const opts of [{slabSize: 0}, {slabSize: NaN}, {slabSize: 16, maxPooledValueSize: 17}, {maxPooledValueSize: -1}]) {
    assert.throws(() => createSlabEncoder(opts), RangeError);
  }
});

test('seeded mixed arrays: owned, prepared and pooled round trips', () => {
  let seed = 0x936ab7;
  const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const pooled = createSlabEncoder({slabSize: 4096});
  for (let i = 0; i < 2000; i++) {
    const arr = Array.from({ length: rand() % 40 }, () => {
      if (rand() & 1) return (rand() | 0) / (rand() % 4 + 1);
      return Array.from({ length: rand() % 40 }, () => String.fromCharCode(rand() & 0xffff)).join('');
    });
    const expected = arr.map(v => typeof v === 'string' ? normalize(v) : v);
    check(arr, expected);
    assert.deepEqual(decode(pooled(arr)), expected);
  }
});
