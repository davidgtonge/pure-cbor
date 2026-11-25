import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  encode, decode, encodeInto, encodedSize, maxEncodedSize, tagged, isTagged, simple, isSimpleValue,
  createSequenceDecoder, CborError,
} from '../dist/index.js';
import { blueskyRecords } from '../bench/corpus/generate.mjs';

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = 'true';
const optional = async name => {
  try { return await import(name); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
};
const cborX = await optional('cbor-x');
const cborg = await optional('cborg');

const hex = s => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = bytes => Buffer.from(bytes).toString('hex');
const error = code => e => e instanceof CborError && e.code === code;
const bytesOf = (...values) => new Uint8Array(values);

// RFC 8949 Appendix A. [wire, decoded value, encodes back to the same wire?]
// Integral floats (1.0, 65504.0, ...) are integers in JS, so they decode to the
// same number but encode as integers; NaN payloads aside, every vector decodes.
const appendixA = [
  ['00', 0, true], ['01', 1, true], ['0a', 10, true], ['17', 23, true], ['1818', 24, true], ['1819', 25, true],
  ['1864', 100, true], ['1903e8', 1000, true], ['1a000f4240', 1000000, true], ['1b000000e8d4a51000', 1000000000000, true],
  ['1bffffffffffffffff', 18446744073709551615n, true], ['c249010000000000000000', 18446744073709551616n, true],
  ['3bffffffffffffffff', -18446744073709551616n, true], ['c349010000000000000000', -18446744073709551617n, true],
  ['20', -1, true], ['29', -10, true], ['3863', -100, true], ['3903e7', -1000, true],
  ['f90000', 0, false], ['f98000', -0, 'shortest'], ['f93c00', 1, false], ['fb3ff199999999999a', 1.1, true],
  ['f93e00', 1.5, 'shortest'], ['f97bff', 65504, false], ['fa47c35000', 100000, false],
  ['fa7f7fffff', 3.4028234663852886e+38, 'shortest'], ['fb7e37e43c8800759c', 1.0e+300, true],
  ['f90001', 5.960464477539063e-8, 'shortest'], ['f90400', 0.00006103515625, 'shortest'], ['f9c400', -4, false],
  ['fbc010666666666666', -4.1, true], ['f97c00', Infinity, 'shortest'], ['f97e00', NaN, 'shortest'], ['f9fc00', -Infinity, 'shortest'],
  ['fa7f800000', Infinity, false], ['fa7fc00000', NaN, false], ['faff800000', -Infinity, false],
  ['fb7ff0000000000000', Infinity, true], ['fb7ff8000000000000', NaN, true], ['fbfff0000000000000', -Infinity, true],
  ['f4', false, true], ['f5', true, true], ['f6', null, true], ['f7', undefined, true],
  ['f0', simple(16), true], ['f8ff', simple(255), true],
  ['c074323031332d30332d32315432303a30343a30305a', new Date('2013-03-21T20:04:00Z'), false],
  ['c11a514b67b0', new Date(1363896240000), true], ['c1fb41d452d9ec200000', new Date(1363896240500), true],
  ['d74401020304', tagged(23, bytesOf(1, 2, 3, 4)), true], ['d818456449455446', tagged(24, bytesOf(0x64, 0x49, 0x45, 0x54, 0x46)), true],
  ['d82076687474703a2f2f7777772e6578616d706c652e636f6d', tagged(32, 'http://www.example.com'), true],
  ['40', new Uint8Array(0), true], ['4401020304', bytesOf(1, 2, 3, 4), true],
  ['60', '', true], ['6161', 'a', true], ['6449455446', 'IETF', true], ['62225c', '"\\', true], ['62c3bc', 'ü', true],
  ['63e6b0b4', '水', true], ['64f0908591', '𐅑', true],
  ['80', [], true], ['83010203', [1, 2, 3], true], ['8301820203820405', [1, [2, 3], [4, 5]], true],
  ['98190102030405060708090a0b0c0d0e0f101112131415161718181819', Array.from({ length: 25 }, (_, i) => i + 1), true],
  ['a0', {}, true], ['a201020304', new Map([[1, 2], [3, 4]]), true], ['a26161016162820203', { a: 1, b: [2, 3] }, true],
  ['826161a161626163', ['a', { b: 'c' }], true],
  ['a56161614161626142616361436164614461656145', { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }, true],
  ['5f42010243030405ff', bytesOf(1, 2, 3, 4, 5), false], ['7f657374726561646d696e67ff', 'streaming', false],
  ['9fff', [], false], ['9f018202039f0405ffff', [1, [2, 3], [4, 5]], false], ['9f01820203820405ff', [1, [2, 3], [4, 5]], false],
  ['83018202039f0405ff', [1, [2, 3], [4, 5]], false], ['83019f0203ff820405', [1, [2, 3], [4, 5]], false],
  ['9f0102030405060708090a0b0c0d0e0f101112131415161718181819ff', Array.from({ length: 25 }, (_, i) => i + 1), false],
  ['bf61610161629f0203ffff', { a: 1, b: [2, 3] }, false], ['826161bf61626163ff', ['a', { b: 'c' }], false],
  ['bf6346756ef563416d7421ff', { Fun: true, Amt: -2 }, false],
];

test('RFC 8949 Appendix A: every example decodes; exact encodings round trip', () => {
  for (const [wire, value, encodes] of appendixA) {
    assert.deepEqual(decode(hex(wire)), value, `decode ${wire}`);
    if (encodes === true) assert.equal(toHex(encode(value)), wire, `encode ${wire}`);
    if (encodes === 'shortest') assert.equal(toHex(encode(value, { floats: 'shortest' })), wire, `shortest ${wire}`);
  }
});

test('undefined and simple values', () => {
  assert.equal(toHex(encode([undefined, null, simple(0), simple(19), simple(32)])), '85f7f6e0f3f820');
  assert.deepEqual(decode(hex('85f7f6e0f3f820')), [undefined, null, simple(0), simple(19), simple(32)]);
  assert.ok(isSimpleValue(simple(5)) && !isSimpleValue({ simple: 5 }));
  for (const bad of [-1, 20, 23, 24, 31, 256, 1.5]) assert.throws(() => simple(bad), RangeError);
  assert.throws(() => decode(hex('f818')), error('invalid-header')); // two-byte form below 32
  assert.deepEqual(decode(encode({ a: undefined, list: [undefined] })), { list: [undefined] });
});

test('bigint: 64-bit integers, bignums, and the safe-integer boundary', () => {
  const cases = [
    [5n, '05'], [-5n, '24'], [2n ** 53n, '1b0020000000000000'], [-(2n ** 53n), '3b001fffffffffffff'],
    [2n ** 64n - 1n, '1bffffffffffffffff'], [2n ** 64n, 'c249010000000000000000'], [-(2n ** 64n) - 1n, 'c349010000000000000000'],
    [2n ** 200n, `c2581a${'01' + '00'.repeat(25)}`],
  ];
  for (const [value, wire] of cases) {
    assert.equal(toHex(encode(value)), wire);
    assert.equal(encodedSize(value), wire.length / 2);
    const decoded = decode(hex(wire));
    // Safe integers decode as numbers: CBOR has one integer type.
    assert.equal(BigInt(decoded), value);
  }
  assert.equal(decode(hex('1b001fffffffffffff')), Number.MAX_SAFE_INTEGER);
  assert.equal(decode(hex('c240')), 0n);
  assert.throws(() => decode(hex('c201')), error('invalid-tag-content'));
  assert.deepEqual(decode(encode([1n, 2n ** 70n, { big: -(2n ** 70n) }])), [1, 2n ** 70n, { big: -(2n ** 70n) }]);
});

test('dates: tag 1 on encode; tags 0 and 1 on decode', () => {
  assert.equal(toHex(encode(new Date(0))), 'c100');
  assert.equal(toHex(encode(new Date(1500))), 'c1fb3ff8000000000000');
  assert.equal(toHex(encode(new Date(1500), { floats: 'shortest' })), 'c1f93e00');
  assert.deepEqual(decode(encode(new Date(Date.UTC(2026, 10, 24, 12)))), new Date(Date.UTC(2026, 10, 24, 12)));
  assert.throws(() => encode(new Date(NaN)), error('unsupported-type'));
  assert.throws(() => decode(hex('c06474657374')), error('invalid-tag-content')); // tag 0 "test"
  assert.throws(() => decode(hex('c16161')), error('invalid-tag-content'));
});

test('tags: Tagged pass-through, custom decoders, self-description, limits', () => {
  const cid = tagged(42, bytesOf(0, 1, 113));
  assert.equal(toHex(encode(cid)), 'd82a4300 0171'.replace(' ', ''));
  const back = decode(encode({ link: cid }));
  assert.ok(isTagged(back.link));
  assert.deepEqual(back, { link: cid });
  assert.ok(!isTagged({ tag: 42, value: 1 }));
  // Custom decoders take precedence, including over built-ins.
  const custom = { 42: content => `cid:${toHex(content)}`, 1: content => `epoch:${content}` };
  assert.deepEqual(decode(encode([cid, new Date(2000)]), { tags: custom }), ['cid:000171', 'epoch:2']);
  assert.throws(() => decode(encode(cid), { unknownTags: 'reject' }), error('unsupported-tag'));
  assert.equal(decode(hex('d9d9f701')), 1); // self-described CBOR marker is unwrapped
  assert.deepEqual(decode(encode(tagged(1000, tagged(1001, [1])))), tagged(1000, tagged(1001, [1])));
  // Tags count toward maxDepth; deep tag chains are a typed error, not a stack overflow.
  assert.throws(() => decode(new Uint8Array(100000).fill(0xc6)), error('depth-limit'));
  assert.throws(() => tagged(-1, 0), RangeError);
  // Typed-array tags keep their fast path unless overridden.
  const floats = new Float64Array([1.5, 2.5]);
  assert.deepEqual(decode(encode(floats)), floats);
  assert.ok(decode(encode(floats), { tags: { 86: content => content.length } }) === 16);
});

test("maps: any keys; 'auto', 'object' and 'map' modes; duplicates", () => {
  const keys = new Map([[1, 'one'], ['two', 2], [bytesOf(3), 3], [[4], 4], [null, 'null'], [-1n << 70n, 'big']]);
  const decoded = decode(encode(keys));
  assert.ok(decoded instanceof Map);
  assert.deepEqual([...decoded.values()], [...keys.values()]);
  assert.deepEqual([...decoded.keys()].map(key => typeof key), ['number', 'string', 'object', 'object', 'object', 'bigint']);
  // Text-only maps decode to objects in 'auto' mode, to Map in 'map' mode.
  assert.deepEqual(decode(encode(new Map([['a', 1]]))), { a: 1 });
  assert.deepEqual(decode(encode({ a: 1, b: { c: 2 } }), { maps: 'map' }), new Map([['a', 1], ['b', new Map([['c', 2]])]]));
  // 'auto' switches to Map mid-map, keeping earlier entries and their order.
  const mixed = decode(hex('a3616101616202' + '0303'));
  assert.deepEqual([...mixed], [['a', 1], ['b', 2], [3, 3]]);
  assert.throws(() => decode(hex('a2616101030302'.slice(0, 12)), { maps: 'object' }), error('unsupported-type'));
  // Duplicates: equal primitive keys are rejected in every mode.
  for (const maps of ['auto', 'object', 'map']) assert.throws(() => decode(hex('a2616101616102'), { maps }), error('duplicate-key'));
  assert.throws(() => decode(hex('a3616101016161 01 02'.replaceAll(' ', ''))), error('duplicate-key'));
  assert.throws(() => decode(hex('a2010101 02'.replaceAll(' ', ''))), error('duplicate-key'));
  assert.deepEqual(decode(hex('a2010101 02'.replaceAll(' ', '')), { duplicateKeys: 'last-wins' }), new Map([[1, 2]]));
  // __proto__ stays an ordinary key in Map mode too.
  assert.deepEqual(decode(encode({ ['__proto__']: 1 }), { maps: 'map' }), new Map([['__proto__', 1]]));
  assert.equal(encodedSize(keys), encode(keys).length);
});

test('indefinite-length items: decoding, limits and malformed input', () => {
  assert.deepEqual(decode(hex('9f9f9fffffff')), [[[]]]);
  assert.deepEqual(decode(hex('bf01029f03ff04ff')), new Map([[1, 2], [[3], 4]]));
  assert.deepEqual(decode(hex('7fff')), '');
  assert.deepEqual(decode(hex('5fff')), new Uint8Array(0));
  for (const [wire, code] of [
    ['5f6161ff', 'invalid-header'],   // text chunk inside a byte string
    ['7f7f6161ffff', 'invalid-header'], // nested indefinite chunk
    ['7f62c3', 'truncated'],
    ['7f62c3ffff', 'invalid-utf8'],
    ['7f61c361bcff', 'invalid-utf8'], // a code point split across chunks
    ['bf6161ff', 'invalid-header'],   // key without a value
    ['9f01', 'truncated'],
    ['ff', 'invalid-header'],
    ['c61f', 'invalid-header'],       // tags cannot be indefinite
  ]) assert.throws(() => decode(hex(wire)), error(code), wire);
  assert.throws(() => decode(hex('9f010203ff'), { maxArrayLength: 2 }), error('array-limit'));
  assert.throws(() => decode(hex('bf01020304ff'), { maxMapEntries: 1 }), error('map-limit'));
  assert.throws(() => decode(new Uint8Array(1000).fill(0x9f)), error('depth-limit'));
  // Byte strings join into a fresh buffer.
  const input = hex('5f42010243030405ff');
  const joined = decode(input);
  input[2] = 99;
  assert.deepEqual(joined, bytesOf(1, 2, 3, 4, 5));
});

test('indefinite-length items stream correctly under every split', () => {
  const items = ['9f018202039f0405ffff', 'bf61610161629f0203ffff', '7f657374726561646d696e67ff', '5f42010243030405ff',
    '9f9f9f01ffffff', 'bf9f01ffbf6161f6ffff'];
  const bytes = hex(items.join(''));
  const expected = items.map(item => decode(hex(item)));
  for (let split = 0; split <= bytes.length; split++) {
    for (const size of [1, 2, 3]) {
      const decoder = createSequenceDecoder();
      const values = [];
      decoder.push(bytes.subarray(0, split), value => values.push(value));
      for (let offset = split; offset < bytes.length; offset += size) decoder.push(bytes.subarray(offset, offset + size), value => values.push(value));
      decoder.end();
      assert.deepEqual(values, expected, `split ${split}, size ${size}`);
    }
  }
});

test('shortest floats: smallest exact width, sizes consistent', () => {
  const vectors = [[0.5, 'f93800'], [-0, 'f98000'], [NaN, 'f97e00'], [Infinity, 'f97c00'], [1.1, 'fb3ff199999999999a'],
    [100000.5, 'fa47c35040'], [2 ** -24, 'f90001'], [2 ** -25, 'fa33000000'], [65504.5, 'fa477fe080'], [1e-310, 'fb000012688b70e62b']];
  for (const [value, wire] of vectors) {
    assert.equal(toHex(encode(value, { floats: 'shortest' })), wire, String(value));
    assert.equal(encodedSize(value, { floats: 'shortest' }), wire.length / 2);
    assert.ok(Object.is(decode(hex(wire)), value));
  }
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const floats = Array.from({ length: 5000 }, (_, i) => [random() * 1e6, Math.fround(random()), (i % 64) / 8, -random() * 1e-5][i % 4]);
  const bytes = encode(floats, { floats: 'shortest' });
  assert.deepEqual(decode(bytes), floats);
  assert.ok(bytes.length < encode(floats).length);
  assert.equal(encodedSize(floats, { floats: 'shortest' }), bytes.length);
  const destination = new Uint8Array(bytes.length);
  assert.equal(encodeInto(floats, destination, 0, { floats: 'shortest' }), bytes.length);
  assert.ok(maxEncodedSize(floats, { floats: 'shortest' }) >= bytes.length);
});

test('deterministic encoding: RFC 8949 §4.2.1 key order, independent of insertion order', () => {
  // The order given in RFC 8949 §4.2.1.
  const ordered = [10, 100, -1, 'z', 'aa', [100], [-1], false];
  let seed = 3;
  const shuffle = list => list.map(value => [((seed = (seed * 1103515245 + 12345) >>> 0)), value]).sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  for (let round = 0; round < 20; round++) {
    const map = new Map(shuffle(ordered).map(key => [key, 0]));
    const decoded = decode(encode(map, { deterministic: true }));
    assert.deepEqual([...decoded.keys()], ordered);
  }
  const one = encode({ b: 1, a: { y: 1.5, x: 2 }, aa: [0.5] }, { deterministic: true });
  const two = encode({ aa: [0.5], a: { x: 2, y: 1.5 }, b: 1 }, { deterministic: true });
  assert.equal(toHex(one), toHex(two));
  // a: {x: 2, y: 1.5}, b: 1, aa: [0.5]: keys by encoded bytes, floats shortest.
  assert.equal(toHex(one), 'a3' + '6161a26178026179f93e00' + '616201' + '62616181f93800');
  // Keys that encode identically are duplicates.
  assert.throws(() => encode(new Map([[1, 'a'], [1n, 'b']]), { deterministic: true }), error('duplicate-key'));
  assert.equal(encodedSize({ b: 1, a: 2 }, { deterministic: true }), encode({ b: 1, a: 2 }, { deterministic: true }).length);
});

test('deterministic output matches cborg (canonical) byte for byte on public data', { skip: !cborg }, () => {
  const corpus = [
    JSON.parse(readFileSync(new URL('../bench/corpus/cbor-x-example4.json', import.meta.url), 'utf8')),
    JSON.parse(readFileSync(new URL('../bench/corpus/msgpack-sample-large.json', import.meta.url), 'utf8')),
    blueskyRecords(50, 5),
  ];
  for (const value of corpus) assert.equal(toHex(encode(value, { deterministic: true })), toHex(cborg.encode(value)));
});

test('cbor-x reads our dates, bigints, Maps and undefined, and we read its', { skip: !cborX }, () => {
  const value = [new Date(1363896240500), 2n ** 70n, -(2n ** 66n), new Map([[1, 'a'], ['b', [2]]]), undefined, null];
  const decoder = new cborX.Decoder({ useRecords: false, mapsAsObjects: false, int64AsNumber: true });
  assert.deepEqual(decoder.decode(encode(value)), value);
  const encoder = new cborX.Encoder({ useRecords: false, mapsAsObjects: false });
  assert.deepEqual(decode(encoder.encode(value)), value);
});

test('random trees with every value kind round trip in all encode modes', () => {
  let seed = 0xbeef;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const int = n => Math.floor(random() * n);
  const leaf = () => [
    () => int(1000) - 500, () => random() * 1e6, () => 'k' + int(100), () => [true, false, null, undefined][int(4)],
    () => BigInt(int(1000)) << 64n, () => new Date(int(2e12)), () => simple(int(20)), () => bytesOf(int(256), int(256)),
  ][int(8)]();
  const tree = depth => {
    if (depth > 3 || random() < 0.4) return leaf();
    switch (int(4)) {
      case 0: return Array.from({ length: int(5) }, () => tree(depth + 1));
      case 1: return Object.fromEntries(Array.from({ length: int(5) }, () => ['p' + int(50), tree(depth + 1)]).filter(([, v]) => v !== undefined));
      case 2: return new Map(Array.from({ length: int(4) }, () => [int(2) ? int(100) : bytesOf(int(9)), tree(depth + 1)]));
      default: return tagged(1000 + int(50), tree(depth + 1));
    }
  };
  // Objects with text keys come back as objects; Maps with any non-text key as Map.
  // CBOR has one integer type: bigints in the safe range come back as numbers.
  const normalize = value => typeof value === 'bigint' && value >= -(2n ** 53n) + 1n && value <= 2n ** 53n - 1n ? Number(value)
    : value instanceof Map && [...value.keys()].every(key => typeof key === 'string')
    ? Object.fromEntries([...value].map(([k, v]) => [k, normalize(v)]))
    : value instanceof Map ? new Map([...value].map(([k, v]) => [k, normalize(v)]))
    : Array.isArray(value) ? value.map(normalize)
    : isTagged(value) ? tagged(value.tag, normalize(value.value))
    : value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) : value;
  for (let index = 0; index < 1500; index++) {
    const value = tree(0);
    for (const options of [undefined, { floats: 'shortest' }, { deterministic: true }]) {
      let bytes;
      try { bytes = encode(value, options); }
      catch (e) { if (options?.deterministic && e.code === 'duplicate-key') continue; throw e; }
      assert.deepEqual(decode(bytes), normalize(value));
      assert.equal(encodedSize(value, options), bytes.length);
    }
  }
});

test('random malformed input with the new major-type forms only yields values or CborErrors', () => {
  let seed = 1234;
  const random = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  const pool = [0x5f, 0x7f, 0x9f, 0xbf, 0xff, 0xc0, 0xc1, 0xc2, 0xc3, 0xd8, 0xd9, 0xf7, 0xf8, 0xf9, 0xe0, 0x1b, 0x3b,
    0x81, 0xa1, 0x41, 0x61, 0x00, 0x18, 0xfa];
  for (let index = 0; index < 30000; index++) {
    const bytes = Uint8Array.from({ length: 1 + random(24) }, () => random(4) ? pool[random(pool.length)] : random(256));
    try { decode(bytes); }
    catch (e) { assert.ok(e instanceof CborError, `${toHex(bytes)}: ${e}`); }
  }
});

test("byte strings: 'copy' (arena), 'copy-separate' and 'borrow' ownership", async () => {
  const { runInNewContext } = await import('node:vm');
  const big = length => Uint8Array.from({ length }, (_, i) => (i * 7) & 255);
  const value = [big(100), big(200), bytesOf(1, 2, 3), { cert: big(300) }];
  const wire = encode(value);

  // Default: copies, independent of the input; large ones share one arena.
  const copied = decode(wire);
  assert.deepEqual(copied, value);
  wire.fill(0, 1); // overwrite the input after decoding
  assert.deepEqual(copied, value, 'results do not depend on the input');
  const restored = encode(value);
  const [a, b, small, { cert }] = decode(restored);
  assert.equal(a.buffer, b.buffer, 'large byte strings share the arena');
  assert.equal(a.buffer, cert.buffer);
  assert.ok(a.buffer.byteLength <= restored.length, 'arena never exceeds the input');
  assert.notEqual(small.buffer, a.buffer, 'small byte strings get their own on-heap copy');
  assert.equal(small.buffer.byteLength, 3);

  // copy-separate: every byte string in its own exact buffer.
  const separate = decode(restored, { binaryOwnership: 'copy-separate' });
  for (const bytes of [separate[0], separate[1], separate[3].cert]) assert.equal(bytes.buffer.byteLength, bytes.length);
  assert.deepEqual(separate, value);

  // borrow: views into the input.
  const borrowed = decode(restored, { binaryOwnership: 'borrow' });
  assert.equal(borrowed[0].buffer, restored.buffer);
  assert.deepEqual(borrowed, value);

  // More than 64 KiB of byte strings spills into further arenas, all correct.
  const many = Array.from({ length: 40 }, (_, i) => big(3000 + i));
  const decodedMany = decode(encode(many));
  assert.deepEqual(decodedMany, many);
  assert.ok(new Set(decodedMany.map(bytes => bytes.buffer)).size >= 2);
  // A cross-realm Uint8Array encodes as the same byte string.
  const foreign = runInNewContext('new Uint8Array([1, 2, 3])');
  assert.equal(toHex(encode(new Map([[1, foreign]]))), toHex(encode(new Map([[1, bytesOf(1, 2, 3)]]))));
});

test('Map and byte-string encode fast paths match the general paths', () => {
  const x = big => Uint8Array.from({ length: big }, (_, i) => i);
  // A COSE_Key: integer keys, byte-string values (RFC 9052 / 9053 labels).
  const key = new Map([[1, 2], [3, -7], [-1, 1], [-2, x(32)], [-3, x(32)], ['kid', 'key-1'], [4, [1, 2]], [5, null]]);
  const bytes = encode(key);
  assert.deepEqual(decode(bytes), key);
  assert.equal(toHex(bytes.subarray(0, 10)), 'a8010203262001215820');
  // Buffer values are byte strings too.
  assert.equal(toHex(encode(new Map([[1, Buffer.from([9, 9])]]))), 'a101420909');
  assert.equal(toHex(encode([Buffer.from([1]), bytesOf(2)])), '8241014102');
  // encodeInto and encodedSize agree with the fast paths.
  const destination = new Uint8Array(bytes.length);
  assert.equal(encodeInto(key, destination), bytes.length);
  assert.deepEqual(destination, bytes);
  assert.equal(encodedSize(key), bytes.length);
});
