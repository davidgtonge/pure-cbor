// The portable conformance suite: the same checks in every runtime pure-cbor
// claims to support (Node, Deno, Bun, browsers, web workers and workerd).
// It uses only the language, TextEncoder/TextDecoder and Web Streams, so it
// imports nothing from Node and needs no file system. The Node-only suites in
// test/*.test.mjs go further; this one is what every runtime must pass.

import {
  encode, decode, tryDecode, encodeInto, encodedSize, maxEncodedSize, createSlabEncoder,
  tagged, isTagged, simple, isSimpleValue, CborError,
  createSequenceDecoder, createSequenceEncoder, decodeStream, encodeStream, decodeSequence, encodeSequence,
} from '../../dist/index.js';
import { blueskyRecords, floatMesh, seededRandom } from '../../bench/corpus/generate.mjs';
import { appendixA } from './appendix-a.mjs';

// ---------------------------------------------------------------- helpers

const fromHex = text => Uint8Array.from(text.match(/../g) ?? [], pair => parseInt(pair, 16));
const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const bytesOf = (...values) => new Uint8Array(values);
const describe = value => (typeof value === 'bigint' ? `${value}n` : typeof value === 'string' ? JSON.stringify(value) : String(value));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function checkEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) throw new Error(`${message}: got ${describe(actual)}, expected ${describe(expected)}`);
}

/** Deep equality for decoded values: order of object keys and Map entries matters. */
function checkSame(actual, expected, where = 'value') {
  if (typeof expected !== 'object' || expected === null) {
    checkEqual(actual, expected, where);
    return;
  }
  check(typeof actual === 'object' && actual !== null, `${where}: got ${describe(actual)}, expected an object`);
  if (expected instanceof Date) {
    check(actual instanceof Date, `${where}: expected a Date`);
    checkEqual(actual.getTime(), expected.getTime(), `${where} time`);
  } else if (ArrayBuffer.isView(expected)) {
    checkEqual(Object.prototype.toString.call(actual), Object.prototype.toString.call(expected), `${where} type`);
    checkEqual(actual.length, expected.length, `${where} length`);
    for (let index = 0; index < expected.length; index++) checkEqual(actual[index], expected[index], `${where}[${index}]`);
  } else if (Array.isArray(expected)) {
    check(Array.isArray(actual), `${where}: expected an array`);
    checkEqual(actual.length, expected.length, `${where} length`);
    expected.forEach((item, index) => checkSame(actual[index], item, `${where}[${index}]`));
  } else if (expected instanceof Map) {
    check(actual instanceof Map, `${where}: expected a Map`);
    const actualEntries = Array.from(actual);
    const expectedEntries = Array.from(expected);
    checkEqual(actualEntries.length, expectedEntries.length, `${where} size`);
    expectedEntries.forEach(([key, item], index) => {
      checkSame(actualEntries[index][0], key, `${where} key ${index}`);
      checkSame(actualEntries[index][1], item, `${where}.get(${describe(key)})`);
    });
  } else if (isTagged(expected)) {
    check(isTagged(actual), `${where}: expected a Tagged value`);
    checkEqual(actual.tag, expected.tag, `${where} tag`);
    checkSame(actual.value, expected.value, `${where} content`);
  } else if (isSimpleValue(expected)) {
    check(isSimpleValue(actual), `${where}: expected a simple value`);
    checkEqual(actual.simple, expected.simple, `${where} simple`);
  } else {
    checkEqual(Object.getPrototypeOf(actual), Object.prototype, `${where} prototype`);
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    checkEqual(actualKeys.join(','), expectedKeys.join(','), `${where} keys`);
    for (const key of expectedKeys) checkSame(actual[key], expected[key], `${where}.${key}`);
  }
}

function checkThrowsCode(run, code, message) {
  try {
    run();
  } catch (error) {
    check(error instanceof CborError, `${message}: threw ${error}, not a CborError`);
    checkEqual(error.code, code, `${message}: error code`);
    return;
  }
  throw new Error(`${message}: did not throw ${code}`);
}

async function collect(readable) {
  const values = [];
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return values;
    values.push(value);
  }
}

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function splitEvery(bytes, size) {
  const chunks = [];
  for (let start = 0; start < bytes.length; start += size) chunks.push(bytes.slice(start, start + size));
  return chunks;
}

function concat(chunks) {
  const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.length;
  }
  return total;
}

// A round trip through every encode path: owned, caller memory and slab.
const slab = createSlabEncoder({ slabSize: 4096 });
function roundTrip(value, expected = value, where = 'value') {
  const bytes = encode(value);
  checkSame(decode(bytes), expected, where);
  checkEqual(encodedSize(value), bytes.length, `${where}: encodedSize`);
  check(maxEncodedSize(value) >= bytes.length, `${where}: maxEncodedSize is an upper bound`);
  checkEqual(bytes.buffer.byteLength, bytes.length, `${where}: owned output is exactly sized`);
  const destination = new Uint8Array(bytes.length + 4).fill(0xaa);
  checkEqual(encodeInto(value, destination, 2), bytes.length + 2, `${where}: encodeInto end`);
  checkEqual(toHex(destination.subarray(2, -2)), toHex(bytes), `${where}: encodeInto bytes`);
  checkEqual(toHex(slab(value)), toHex(bytes), `${where}: slab bytes`);
  return bytes;
}

// ---------------------------------------------------------------- the cases

const cases = [];
const testCase = (name, run) => cases.push({ name, run });

testCase('RFC 8949 Appendix A: every example decodes; exact encodings round trip', () => {
  for (const [wire, value, encodes] of appendixA) {
    checkSame(decode(fromHex(wire)), value, `decode ${wire}`);
    if (encodes === true) checkEqual(toHex(encode(value)), wire, `encode ${wire}`);
    if (encodes === 'shortest') checkEqual(toHex(encode(value, { floats: 'shortest' })), wire, `shortest ${wire}`);
  }
});

testCase('integers at every width boundary, as numbers and bigints', () => {
  for (const magnitude of [0, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER]) {
    roundTrip(magnitude);
    roundTrip(-magnitude - 1);
  }
  roundTrip(2n ** 64n - 1n);
  roundTrip(-(2n ** 64n));
  roundTrip(2n ** 64n);
  roundTrip(-(2n ** 200n) - 12345n);
  roundTrip(9007199254740993n);
  roundTrip(5n, 5, 'a safe bigint decodes as a number');
});

testCase('floats: float64 by default, shortest on request', () => {
  for (const value of [0.1, -0, 1.5, NaN, Infinity, -Infinity, 1e300, 5e-324, 3.4028234663852886e38]) roundTrip(value);
  checkEqual(toHex(encode(1.5)), 'fb3ff8000000000000', 'float64 by default');
  checkEqual(toHex(encode(1.5, { floats: 'shortest' })), 'f93e00', 'shortest');
  checkEqual(toHex(encode(100000.5, { floats: 'shortest' })), 'fa47c35040', 'single precision');
});

testCase('text: ASCII, multi-byte and long strings agree with TextEncoder', () => {
  const encoder = new TextEncoder();
  const samples = ['', 'a', 'Ada', 'x'.repeat(23), 'x'.repeat(24), 'naïve café', '水', '𐅑', '🎉'.repeat(40), 'long '.repeat(2000)];
  for (const text of samples) {
    const bytes = roundTrip(text, text, `text of ${text.length}`);
    const utf8 = encoder.encode(text);
    checkEqual(toHex(bytes.subarray(bytes.length - utf8.length)), toHex(utf8), `UTF-8 of ${text.slice(0, 12)}`);
  }
  roundTrip('\ud800', '�', 'a lone surrogate is written as U+FFFD');
});

testCase('invalid UTF-8 is rejected by default and replaced on request, as TextDecoder does', () => {
  const replacing = new TextDecoder('utf-8');
  for (const payload of ['c328', 'e28228', 'f0288c28', 'ff', 'eda080', 'c0af', '61f09f98']) {
    const wire = fromHex((0x60 + payload.length / 2).toString(16) + payload);
    checkThrowsCode(() => decode(wire), 'invalid-utf8', `reject ${payload}`);
    checkEqual(decode(wire, { invalidUtf8: 'replace' }), replacing.decode(fromHex(payload)), `replace ${payload}`);
  }
});

testCase('arrays, objects and Maps, nested', () => {
  roundTrip([]);
  roundTrip({});
  roundTrip([1, 'two', [3, [4, [5]]], { six: 6 }, null, true, false]);
  roundTrip({ id: 7, name: 'Ada', tags: ['x', 'y'], active: true, manager: null });
  roundTrip(Array.from({ length: 300 }, (_, index) => index * 3));
  roundTrip(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key${index}`, index])));
  roundTrip(new Map([[1, 2], [-3, 'four'], ['five', 6], [bytesOf(7), [8]]]));
  roundTrip(new Map([['all', 1], ['text', 2]]), { all: 1, text: 2 }, 'a Map with only text keys');
  roundTrip({ skipped: undefined, kept: 1 }, { kept: 1 }, 'undefined properties are skipped');
  roundTrip([undefined], [undefined], 'undefined in an array is kept');
});

testCase('dates, tags and simple values', () => {
  roundTrip(new Date(0));
  roundTrip(new Date('2026-11-25T09:00:00.250Z'));
  roundTrip(tagged(32, 'https://example.com'));
  roundTrip(tagged(1000, { nested: tagged(1001, [1, 2]) }));
  roundTrip([simple(0), simple(19), simple(32), simple(255)]);
  checkSame(decode(fromHex('c074323031332d30332d32315432303a30343a30305a')), new Date('2013-03-21T20:04:00Z'), 'tag 0');
  checkSame(decode(fromHex('d9d9f7a0')), {}, 'self-described CBOR is unwrapped');
  checkSame(decode(fromHex('d82a01'), { tags: { 42: content => `custom ${content}` } }), 'custom 1', 'a custom tag decoder');
  checkThrowsCode(() => decode(fromHex('d82a01'), { unknownTags: 'reject' }), 'unsupported-tag', 'unknownTags: reject');
  checkThrowsCode(() => encode(new Date(NaN)), 'unsupported-type', 'an invalid Date');
});

testCase('typed arrays of every kind, in both byte orders on the wire', () => {
  const kinds = [
    new Uint8Array([0, 1, 255]), new Uint8ClampedArray([0, 128, 255]), new Int8Array([-128, 0, 127]),
    new Uint16Array([0, 1, 65535]), new Int16Array([-32768, 1, 32767]), new Uint32Array([0, 1, 4294967295]),
    new Int32Array([-2147483648, 1, 2147483647]), new Float32Array([1.5, -0, Infinity]),
    new Float64Array([Math.PI, -0, NaN]), new BigInt64Array([-(2n ** 63n), 1n]), new BigUint64Array([0n, 2n ** 64n - 1n]),
  ];
  for (const array of kinds) roundTrip(array, array, array.constructor.name);
  // Big-endian float64 (tag 82) and little-endian uint16 (tag 69), written by hand.
  checkSame(decode(fromHex('d852483ff8000000000000')), new Float64Array([1.5]), 'tag 82');
  checkSame(decode(fromHex('d84544010002ff')), new Uint16Array([1, 0xff02]), 'tag 69');
});

testCase('deterministic encoding sorts keys by their encoded bytes', () => {
  checkEqual(toHex(encode({ b: 1, a: 2 }, { deterministic: true })), 'a2616102616201', 'text keys');
  const first = encode(new Map([[10, 'x'], [-1, 'y'], ['z', 1], [100, 'w']]), { deterministic: true });
  const second = encode(new Map([[100, 'w'], ['z', 1], [-1, 'y'], [10, 'x']]), { deterministic: true });
  checkEqual(toHex(first), toHex(second), 'insertion order does not matter');
  checkEqual(toHex(first), 'a40a61781864617720617961 7a01'.replace(/ /g, ''), 'RFC 8949 §4.2.1 order');
  checkThrowsCode(() => encode(new Map([[1, 'a'], [1n, 'b']]), { deterministic: true }), 'duplicate-key', 'keys that encode the same');
});

testCase('seeded random trees round trip in all encode modes', () => {
  const random = seededRandom(0xbeef);
  const integer = limit => Math.floor(random() * limit);
  const leaf = () => [
    () => integer(1000) - 500, () => random() * 1e6, () => 'k' + integer(100), () => [true, false, null][integer(3)],
    () => BigInt(integer(1000)) << 64n, () => new Date(integer(2e12)), () => simple(integer(20)), () => bytesOf(integer(256), integer(256)),
  ][integer(8)]();
  const tree = depth => {
    if (depth > 3 || random() < 0.4) return leaf();
    switch (integer(4)) {
      case 0: return Array.from({ length: integer(5) }, () => tree(depth + 1));
      case 1: return Object.fromEntries(Array.from({ length: integer(5) }, () => ['p' + integer(50), tree(depth + 1)]));
      case 2: return new Map(Array.from({ length: integer(4) }, (_, index) => [integer(2) ? integer(100) * 10 + index : bytesOf(integer(9), index), tree(depth + 1)]));
      default: return tagged(1000 + integer(50), tree(depth + 1));
    }
  };
  for (let index = 0; index < 400; index++) {
    const value = tree(0);
    const plain = decode(encode(value));
    for (const options of [undefined, { floats: 'shortest' }]) {
      const bytes = encode(value, options);
      checkSame(decode(bytes), plain, `tree ${index}, ${JSON.stringify(options)}`);
      checkEqual(encodedSize(value, options), bytes.length, `tree ${index}: encodedSize`);
    }
    // Deterministic output reorders entries, so check it is a fixed point instead.
    const canonical = encode(value, { deterministic: true });
    checkEqual(toHex(encode(decode(canonical), { deterministic: true })), toHex(canonical), `tree ${index}: deterministic is canonical`);
    checkEqual(toHex(encode(plain, { deterministic: true })), toHex(canonical), `tree ${index}: deterministic ignores insertion order`);
  }
});

testCase('public-style corpus: Bluesky records and a float mesh', () => {
  const records = blueskyRecords(100);
  checkSame(decode(roundTrip(records, records, 'records')), records, 'records');
  const mesh = floatMesh(200);
  checkSame(decode(encode(mesh)), mesh, 'mesh');
  checkEqual(toHex(encode(records, { deterministic: true })), toHex(encode(decode(encode(records)), { deterministic: true })), 'deterministic is stable');
});

testCase('malformed input fails with the documented error codes', () => {
  const cases = [
    ['a26269640764', 'truncated'], ['0102', 'trailing-data'], ['a2616101616102', 'duplicate-key'],
    ['81'.repeat(200) + '00', 'depth-limit'], ['7affffffff', 'truncated'], ['1c', 'invalid-header'],
    ['9b0000000100000000', 'array-limit'], ['ff', 'invalid-header'], ['5f61ff', 'invalid-header'],
  ];
  for (const [wire, code] of cases) {
    const bytes = fromHex(wire);
    checkThrowsCode(() => decode(bytes), code, wire.slice(0, 20));
    const result = tryDecode(bytes);
    check(!result.ok && result.error.code === code, `tryDecode ${wire.slice(0, 20)}`);
  }
  checkSame(decode(fromHex('a2616101616102'), { duplicateKeys: 'last-wins' }), { a: 2 }, 'last-wins');
  checkThrowsCode(() => decode(fromHex('83010203'), { maxArrayLength: 2 }), 'array-limit', 'maxArrayLength');
  const cyclic = [];
  cyclic.push(cyclic);
  checkThrowsCode(() => encode(cyclic), 'depth-limit', 'cyclic input');
  checkThrowsCode(() => encode(Symbol('no')), 'unsupported-type', 'a symbol');
  checkThrowsCode(() => encode(new (class Point { constructor() { this.x = 1; } })()), 'unsupported-type', 'a class instance');
});

testCase('random malformed input only yields values or CborErrors', () => {
  const random = seededRandom(1234);
  const pool = [0x5f, 0x7f, 0x9f, 0xbf, 0xff, 0xc0, 0xc1, 0xc2, 0xd8, 0xf7, 0xf9, 0xfa, 0x1b, 0x81, 0xa1, 0x41, 0x61, 0x00, 0x18];
  for (let index = 0; index < 5000; index++) {
    const bytes = Uint8Array.from({ length: 1 + Math.floor(random() * 24) }, () => (random() < 0.75 ? pool[Math.floor(random() * pool.length)] : Math.floor(random() * 256)));
    try {
      decode(bytes);
    } catch (error) {
      check(error instanceof CborError, `${toHex(bytes)}: ${error}`);
    }
  }
});

testCase('__proto__ keys decode as own data properties', () => {
  const value = decode(fromHex('a1695f5f70726f746f5f5fa1617801'));
  checkEqual(Object.getPrototypeOf(value), Object.prototype, 'prototype unchanged');
  check(Object.prototype.hasOwnProperty.call(value, '__proto__'), 'own __proto__ property');
  checkEqual(value.x, undefined, 'nothing inherited');
});

testCase("byte strings: 'copy', 'copy-separate' and 'borrow'", () => {
  const large = length => Uint8Array.from({ length }, (_, index) => (index * 7) & 255);
  const value = [large(100), large(200), bytesOf(1, 2, 3)];
  const wire = encode(value);
  const copied = decode(wire);
  const separate = decode(wire, { binaryOwnership: 'copy-separate' });
  const borrowed = decode(wire, { binaryOwnership: 'borrow' });
  checkEqual(borrowed[0].buffer, wire.buffer, 'borrow returns views into the input');
  checkEqual(separate[1].buffer.byteLength, 200, 'copy-separate gives exact buffers');
  wire.fill(0);
  checkSame(copied, value, 'copies do not depend on the input');
  checkSame(separate, value, 'separate copies do not depend on the input');
});

testCase('caller memory: capacity errors never write partially', () => {
  const value = { list: [1, 2, 3], text: 'hello' };
  const size = encodedSize(value);
  const destination = new Uint8Array(size - 1).fill(0xaa);
  checkThrowsCode(() => encodeInto(value, destination), 'capacity', 'one byte short');
  check(destination.every(byte => byte === 0xaa), 'nothing was written');
  checkThrowsCode(() => encodeInto('x'.repeat(100), new Uint8Array(50)), 'capacity', 'long text');
});

testCase('the slab encoder never overwrites earlier views', () => {
  const pooled = createSlabEncoder({ slabSize: 256 });
  const outputs = Array.from({ length: 50 }, (_, index) => [index, pooled({ index, name: `row ${index}` })]);
  checkEqual(outputs[0][1].buffer, outputs[1][1].buffer, 'small values share a slab');
  for (const [index, bytes] of outputs) checkSame(decode(bytes), { index, name: `row ${index}` }, `slab value ${index}`);
});

const sequenceValues = [1, 'two', [3, 4], { five: 5, six: [6, 6] }, new Map([[7, 'seven']]), 2n ** 70n, new Float64Array([8.5]), 'x'.repeat(300), null];
const sequenceBytes = concat(sequenceValues.map(value => encode(value)));

testCase('a sequence decodes the same under every chunk size from 1 to 64 bytes', () => {
  for (let size = 1; size <= 64; size++) {
    const decoder = createSequenceDecoder();
    const values = [];
    for (const chunk of splitEvery(sequenceBytes, size)) decoder.push(chunk, value => values.push(value));
    decoder.end();
    checkSame(values, sequenceValues, `chunks of ${size}`);
  }
  const decoder = createSequenceDecoder();
  decoder.push(sequenceBytes.subarray(0, 6), () => {}); // 01, then 63 'two', then the 82 of [3, 4]
  checkThrowsCode(() => decoder.end(), 'truncated', 'end() mid-item');
});

testCase('the sequence encoder, in both modes', () => {
  for (const chunkBytes of [0, 16, 1024]) {
    const encoder = createSequenceEncoder({ chunkBytes });
    const chunks = [];
    for (const value of sequenceValues) encoder.push(value, chunk => chunks.push(chunk));
    encoder.flush(chunk => chunks.push(chunk));
    checkEqual(toHex(concat(chunks)), toHex(sequenceBytes), `chunkBytes ${chunkBytes}`);
  }
});

testCase('Web Streams: decodeStream and encodeStream, one value at a time and batched', async () => {
  const decoded = await collect(streamOf(splitEvery(sequenceBytes, 7)).pipeThrough(decodeStream()));
  checkSame(decoded, sequenceValues, 'decodeStream');
  const batches = await collect(streamOf(splitEvery(sequenceBytes, 100)).pipeThrough(decodeStream({ batch: true })));
  checkSame(batches.flat(), sequenceValues, 'decodeStream batch');
  const encoded = await collect(streamOf(sequenceValues).pipeThrough(encodeStream()));
  checkEqual(toHex(concat(encoded)), toHex(sequenceBytes), 'encodeStream');
  const batchEncoded = await collect(streamOf([sequenceValues.slice(0, 4), sequenceValues.slice(4)]).pipeThrough(encodeStream({ batch: true })));
  checkEqual(toHex(concat(batchEncoded)), toHex(sequenceBytes), 'encodeStream batch');
  let failure;
  try {
    await collect(streamOf([fromHex('a2')]).pipeThrough(decodeStream()));
  } catch (error) {
    failure = error;
  }
  check(failure instanceof CborError && failure.code === 'truncated', 'a truncated stream errors with truncated');
});

testCase('decodeSequence and encodeSequence: async iteration both ways', async () => {
  const values = [];
  for await (const value of decodeSequence(streamOf(splitEvery(sequenceBytes, 5)))) values.push(value);
  checkSame(values, sequenceValues, 'decodeSequence over a ReadableStream');
  const fromIterable = [];
  for await (const value of decodeSequence(splitEvery(sequenceBytes, 3))) fromIterable.push(value);
  checkSame(fromIterable, sequenceValues, 'decodeSequence over an array of chunks');
  async function* generate() { yield* sequenceValues; }
  const encoded = await collect(encodeSequence(generate()));
  checkEqual(toHex(concat(encoded)), toHex(sequenceBytes), 'encodeSequence');
});

// ---------------------------------------------------------------- running

/** Runs every case; never throws. Returns a summary any runtime can report. */
export async function runSuite() {
  const results = [];
  for (const { name, run } of cases) {
    const started = Date.now();
    try {
      await run();
      results.push({ name, ok: true, milliseconds: Date.now() - started });
    } catch (error) {
      results.push({ name, ok: false, milliseconds: Date.now() - started, error: String(error && error.stack || error) });
    }
  }
  return { passed: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length, results };
}

export { cases };
