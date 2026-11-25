import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  encode, decode, CborError,
  createSequenceDecoder, createSequenceEncoder,
  decodeStream, encodeStream, decodeSequence, encodeSequence,
} from '../dist/index.js';
import { blueskyRecords, floatMesh } from '../bench/corpus/generate.mjs';

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = 'true';
let reference;
try { reference = await import('cbor-x'); }
catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }

const error = code => e => e instanceof CborError && e.code === code;
const concat = parts => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const sequenceOf = values => concat(values.map(value => encode(value)));

/** Decode `bytes` fed in the given chunk sizes (cycled). */
function decodeChunked(bytes, sizes, options) {
  const decoder = createSequenceDecoder(options);
  const values = [];
  let offset = 0;
  for (let index = 0; offset < bytes.length; index++) {
    const size = sizes[index % sizes.length];
    decoder.push(bytes.subarray(offset, offset + size), value => values.push(value));
    offset += size;
  }
  decoder.end();
  return values;
}

const mixed = [
  0, 23, 24, -1, 2 ** 40, 1.5, NaN, true, false, null, '', 'é水😀', 'x'.repeat(300),
  [], [1, [2, [3]]], {}, { a: 1, nested: { list: ['x', null, 2.5] } },
  new Uint8Array([1, 2, 3]), new Float64Array([Math.PI, -0]), new Int16Array([-1, 2]),
  Array.from({ length: 50 }, (_, i) => ({ id: i, name: `n${i}` })),
];

test('every split point of a sequence decodes to the same values', () => {
  const bytes = sequenceOf(mixed);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = createSequenceDecoder();
    const values = [];
    decoder.push(bytes.subarray(0, split), value => values.push(value));
    decoder.push(bytes.subarray(split), value => values.push(value));
    decoder.end();
    assert.deepEqual(values, mixed, `split at ${split}`);
  }
});

test('every fixed chunk size, and random chunking, decode identically', () => {
  const values = [...mixed, ...blueskyRecords(30, 3), floatMesh(20, 3)];
  const bytes = sequenceOf(values);
  for (let size = 1; size <= 64; size++) assert.deepEqual(decodeChunked(bytes, [size]), values, `size ${size}`);
  let seed = 42;
  const random = limit => { seed = (seed * 1103515245 + 12345) >>> 0; return 1 + (seed % limit); };
  for (let round = 0; round < 200; round++) {
    const sizes = Array.from({ length: 50 }, () => random(round % 2 ? 9 : 4096));
    assert.deepEqual(decodeChunked(bytes, sizes), values);
  }
  // Empty chunks are harmless.
  assert.deepEqual(decodeChunked(bytes, [0, 5, 0, 3]), values);
});

test('items spanning many chunks are decoded in linear time', () => {
  const time = (value, chunkSize) => {
    const bytes = encode(value);
    const start = performance.now();
    const [decoded] = decodeChunked(bytes, [chunkSize]);
    assert.equal(decoded.length, value.length);
    return performance.now() - start;
  };
  // A quadratic rescan would make 4x the data take ~16x the time.
  for (const make of [n => 'x'.repeat(n), n => Array.from({ length: n / 8 }, (_, i) => i)]) {
    time(make(1 << 19), 1024); // warm up
    const small = time(make(1 << 20), 1024);
    const large = time(make(1 << 22), 1024);
    assert.ok(large < Math.max(small, 1) * 10, `4x data took ${(large / small).toFixed(1)}x time`);
  }
});

test('maxItemBytes bounds buffering before the bytes arrive', () => {
  // A 4 GB text header: rejected after 5 bytes, nothing large buffered.
  const decoder = createSequenceDecoder({ maxItemBytes: 1024 });
  assert.throws(() => decoder.push(new Uint8Array([0x01, 0x7a, 0xff, 0xff, 0xff, 0xff]), () => {}), error('item-limit'));
  // An array header declaring 983,040 elements (within maxArrayLength), cut
  // off: rejected from the header, since each element needs at least a byte.
  assert.throws(() => createSequenceDecoder({ maxItemBytes: 1 << 16 }).push(new Uint8Array([0x9a, 0x00, 0x0f, 0x00, 0x00, 0x01]), () => {}),
    error('item-limit'));
  // Beyond maxArrayLength, the array limit reports first.
  assert.throws(() => createSequenceDecoder().push(new Uint8Array([0x9a, 0xff, 0xff, 0xff, 0xff, 0x01]), () => {}),
    error('array-limit'));
  // An item complete inside one chunk is held to the same limit.
  assert.throws(() => createSequenceDecoder({ maxItemBytes: 10 }).push(encode('x'.repeat(20)), () => {}), error('item-limit'));
  assert.deepEqual(decodeChunked(encode('x'.repeat(20)), [3], { maxItemBytes: 22 }), ['x'.repeat(20)]);
  for (const value of [0, -1, 1.5, NaN]) assert.throws(() => createSequenceDecoder({ maxItemBytes: value }), error('item-limit'));
  // Per-item decode limits still apply.
  const deep = sequenceOf([[[[1]]]]);
  assert.throws(() => decodeChunked(deep, [2], { maxDepth: 2 }), error('depth-limit'));
});

test('errors report absolute stream offsets; truncation at the end', () => {
  const good = sequenceOf([1, 'abc', [1, 2]]);
  const bad = new Uint8Array([0x62, 0xc3, 0x28]); // invalid UTF-8
  const bytes = concat([good, bad]);
  for (const size of [1, 2, 3, 100]) {
    assert.throws(() => decodeChunked(bytes, [size]), e => e.code === 'invalid-utf8' && e.offset >= good.length,
      `size ${size}`);
  }
  // Ends inside an item: truncated, at the item's start.
  const cut = sequenceOf(['hello', { a: [1, 2, 3] }]);
  const decoder = createSequenceDecoder();
  decoder.push(cut.subarray(0, cut.length - 2), () => {});
  assert.equal(decoder.bufferedBytes, cut.length - 2 - 6);
  assert.throws(() => decoder.end(), e => e.code === 'truncated' && e.offset === 6);
  // Reserved headers are rejected whatever the chunking.
  assert.throws(() => decodeChunked(new Uint8Array([0x81, 0x1c]), [1]), error('invalid-header'));
});

test('decoder state: failed stays failed, no push after end, no reentrant push', () => {
  const decoder = createSequenceDecoder();
  assert.throws(() => decoder.push(new Uint8Array([0xff]), () => {}), error('invalid-header'));
  assert.throws(() => decoder.push(encode(1), () => {}), error('invalid-header'));
  const ended = createSequenceDecoder();
  ended.end();
  assert.throws(() => ended.push(encode(1), () => {}), TypeError);
  const reentrant = createSequenceDecoder();
  assert.throws(() => reentrant.push(sequenceOf([1, 2]), () => reentrant.push(encode(3), () => {})), TypeError);
  assert.equal(createSequenceDecoder().offset, 0);
});

test('borrowed values stay valid as later chunks arrive', () => {
  const floats = new Float64Array([1.5, 2.5, 3.5, 4.5]);
  const bytes = sequenceOf([floats, floats, 'tail']);
  const values = decodeChunked(bytes, [5], { binaryOwnership: 'borrow' });
  assert.deepEqual(values, [floats, floats, 'tail']);
});

test('sequence encoder: chunkBytes 0 and N produce identical bytes', () => {
  const values = [...mixed, ...blueskyRecords(40, 9)];
  const expected = sequenceOf(values);
  for (const chunkBytes of [0, 1, 16, 1024, 1 << 20]) {
    const encoder = createSequenceEncoder({ chunkBytes });
    const chunks = [];
    for (const value of values) encoder.push(value, chunk => chunks.push(chunk));
    encoder.flush(chunk => chunks.push(chunk));
    assert.deepEqual(concat(chunks), expected, `chunkBytes ${chunkBytes}`);
    if (chunkBytes > 0) chunks.slice(0, -1).forEach(chunk => assert.ok(chunk.length >= chunkBytes));
    if (chunkBytes === 0) assert.equal(chunks.length, values.length);
  }
  // An unsupported value leaves no partial bytes behind.
  const encoder = createSequenceEncoder({ chunkBytes: 1024 });
  const chunks = [];
  encoder.push({ a: 1 }, chunk => chunks.push(chunk));
  assert.throws(() => encoder.push({ b: [1, new Set()] }, () => {}), error('unsupported-type'));
  encoder.push('ok', chunk => chunks.push(chunk));
  encoder.flush(chunk => chunks.push(chunk));
  assert.deepEqual(concat(chunks), sequenceOf([{ a: 1 }, 'ok']));
  assert.throws(() => createSequenceEncoder({ chunkBytes: -1 }), RangeError);
});

const streamOf = chunks => new ReadableStream({ start(controller) { chunks.forEach(c => controller.enqueue(c)); controller.close(); } });
const collect = async iterable => { const out = []; for await (const item of iterable) out.push(item); return out; };
const chunked = (bytes, size) => Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size));

test('Web Streams: pipeThrough both ways', async () => {
  const values = [...mixed, ...blueskyRecords(20, 5)];
  for (const chunkBytes of [0, 256]) {
    const decoded = await collect(streamOf(values).pipeThrough(encodeStream({ chunkBytes })).pipeThrough(decodeStream()));
    assert.deepEqual(decoded, values);
  }
  // ArrayBuffer and other views are accepted as input chunks.
  const bytes = sequenceOf([1, 'two']);
  const asBuffers = [bytes.slice(0, 2).buffer, new DataView(bytes.slice(2).buffer)];
  assert.deepEqual(await collect(streamOf(asBuffers).pipeThrough(decodeStream())), [1, 'two']);
  // Decode errors error the stream.
  await assert.rejects(collect(streamOf([new Uint8Array([0x61])]).pipeThrough(decodeStream())), error('truncated'));
  await assert.rejects(collect(streamOf(['text']).pipeThrough(decodeStream())), error('invalid-buffer'));
});

test('decodeSequence: streams, async and sync iterables; early exit cancels', async () => {
  const values = [...mixed];
  const bytes = sequenceOf(values);
  assert.deepEqual(await collect(decodeSequence(streamOf(chunked(bytes, 3)))), values);
  assert.deepEqual(await collect(decodeSequence(Readable.from(chunked(bytes, 5)))), values);
  assert.deepEqual(await collect(decodeSequence(chunked(bytes, 7))), values);
  let cancelled = false;
  const endless = new ReadableStream({
    pull(controller) { controller.enqueue(encode({ tick: 1 })); },
    cancel() { cancelled = true; },
  });
  let count = 0;
  for await (const value of decodeSequence(endless)) { assert.deepEqual(value, { tick: 1 }); if (++count === 3) break; }
  assert.ok(cancelled);
  await assert.rejects(collect(decodeSequence([bytes.subarray(0, bytes.length - 1)])), error('truncated'));
});

test('encodeSequence: pulls lazily from sync and async iterables', async () => {
  const values = [...mixed, ...blueskyRecords(10, 2)];
  for (const chunkBytes of [0, 100]) {
    assert.deepEqual(concat(await collect(encodeSequence(values, { chunkBytes }))), sequenceOf(values));
    async function* generate() { for (const value of values) yield value; }
    assert.deepEqual(concat(await collect(encodeSequence(generate(), { chunkBytes }))), sequenceOf(values));
  }
  let produced = 0;
  function* counter() { for (;;) { produced++; yield produced; } }
  const reader = encodeSequence(counter()).getReader();
  await reader.read();
  await reader.read();
  assert.ok(produced <= 3, `pulled ${produced} values for 2 reads`);
  await reader.cancel();
});

test('interop with cbor-x streams (Node streams, standard mode)', { skip: !reference }, async () => {
  const values = [...blueskyRecords(50, 11), { list: [1, 2.5, 'x', null] }, 'done'];
  // cbor-x EncoderStream -> our decodeSequence
  const encoderStream = new reference.EncoderStream({ useRecords: false });
  const ours = decodeSequence(encoderStream);
  for (const value of values) encoderStream.write(value);
  encoderStream.end();
  assert.deepEqual(await collect(ours), values);
  // our encodeSequence -> cbor-x DecoderStream
  const decoded = [];
  await pipeline(
    Readable.fromWeb(encodeSequence(values, { chunkBytes: 333 })),
    new reference.DecoderStream({ useRecords: false }),
    new Writable({ objectMode: true, write(value, _, done) { decoded.push(value); done(); } }),
  );
  assert.deepEqual(decoded, values);
});

test('malformed input reports the same error code however it is chunked', () => {
  const hex = s => Uint8Array.from(Buffer.from(s, 'hex'));
  const cases = ['ff', 'f7', '1c', '7f', '9f01ff', '9affffffff01', 'ba00ffffff', 'a2616101616102', '62c328',
    'c000', 'a10102', 'd84c40', 'fb7ff8', '8181818181818181f6',
    '9f9f01', 'bf6161ff', '5f6161ff', '7f61c361bcff', 'c61f', 'f818', '9f01', 'c2a0', 'bf9f01ffff'];
  const prefix = encode({ ok: [1, 'x'] });
  for (const malformed of cases) {
    const bytes = concat([prefix, hex(malformed)]);
    const codes = new Set();
    for (let size = 1; size <= bytes.length; size++) {
      try { decodeChunked(bytes, [size], { maxDepth: 4 }); codes.add('ok'); }
      catch (e) { codes.add(e.code); }
    }
    let whole;
    try { decode(hex(malformed), { maxDepth: 4 }); whole = 'ok'; } catch (e) { whole = e.code; }
    assert.deepEqual([...codes], [whole], `${malformed}: ${[...codes]} vs decode() ${whole}`);
  }
});

test('batch decodeStream: one array per chunk that completes values', async () => {
  const values = [...mixed, ...blueskyRecords(30, 4)];
  const bytes = sequenceOf(values);
  for (const size of [1, 7, 100, 4096, bytes.length]) {
    const batches = await collect(streamOf(chunked(bytes, size)).pipeThrough(decodeStream({ batch: true })));
    assert.ok(batches.every(batch => Array.isArray(batch) && batch.length > 0), 'no empty batches');
    assert.ok(batches.length <= Math.ceil(bytes.length / size));
    assert.deepEqual(batches.flat(), values);
  }
  await assert.rejects(collect(streamOf([bytes.subarray(0, bytes.length - 1)]).pipeThrough(decodeStream({ batch: true }))),
    error('truncated'));
});

test('batch encodeStream: arrays in; chunkBytes 0 gives one chunk per batch', async () => {
  const values = [...mixed, ...blueskyRecords(30, 4)];
  const batches = [values.slice(0, 5), [], values.slice(5, 20), values.slice(20)];
  const perBatch = await collect(streamOf(batches).pipeThrough(encodeStream({ batch: true })));
  assert.equal(perBatch.length, batches.filter(batch => batch.length > 0).length);
  perBatch.forEach((chunk, index) => assert.deepEqual(chunk, sequenceOf(batches.filter(b => b.length > 0)[index])));
  const coalesced = await collect(streamOf(batches).pipeThrough(encodeStream({ batch: true, chunkBytes: 512 })));
  assert.deepEqual(concat(coalesced), sequenceOf(values));
  coalesced.slice(0, -1).forEach(chunk => assert.ok(chunk.length >= 512));
  // Round trip through both batch modes.
  const back = await collect(streamOf(batches).pipeThrough(encodeStream({ batch: true })).pipeThrough(decodeStream({ batch: true })));
  assert.deepEqual(back.flat(), values);
  await assert.rejects(collect(streamOf([{ not: 'an array' }]).pipeThrough(encodeStream({ batch: true }))), error('unsupported-type'));
});

test('encodeStream keeps encode options in every mode', async () => {
  const values = [{ b: 1, a: 1.5 }, [0.5, { z: null, y: 2 }]];
  const expected = concat(values.map(value => encode(value, { deterministic: true })));
  const modes = [{}, { chunkBytes: 16 }, { batch: true }, { batch: true, chunkBytes: 16 }];
  for (const mode of modes) {
    const input = mode.batch ? [values] : values;
    const chunks = await collect(streamOf(input).pipeThrough(encodeStream({ ...mode, deterministic: true })));
    assert.deepEqual(concat(chunks), expected, JSON.stringify(mode));
  }
});
