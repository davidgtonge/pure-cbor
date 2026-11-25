import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, CborError } from '../dist/index.js';

const hex = string => Uint8Array.from(Buffer.from(string, 'hex'));
const error = code => exception => exception instanceof CborError && exception.code === code;

test('duplicateKeys: last-wins keeps the last value of equal object keys', () => {
  // Identical byte strings, including non-preferred and chunked encodings,
  // and identical arrays. A Map compares these by identity, so both entries
  // currently survive.
  for (const wire of [
    'a24101616141016162',         // h'01' -> "a", h'01' -> "b"
    'a2410161615801016162',       // second key uses a non-preferred length
    'a2410161615f4101ff6162',     // second key is the same bytes in chunks
    'a28101616181016162',         // [1] -> "a", [1] -> "b"
  ]) {
    const map = decode(hex(wire), { duplicateKeys: 'last-wins' });
    assert.equal(map.size, 1, wire);
    assert.deepEqual([...map.values()], ['b'], wire);
  }
});

test('an indefinite byte string cannot force one allocation per chunk', () => {
  const chunks = 20_000;
  const bytes = new Uint8Array(2 + chunks * 2);
  bytes[0] = 0x5f;
  for (let index = 0; index < chunks; index++) {
    bytes[1 + index * 2] = 0x41;       // one-byte chunk header
    bytes[2 + index * 2] = 0x41;       // payload
  }
  bytes[bytes.length - 1] = 0xff;
  // Valid CBOR, so it decodes; the chunks are copied into one buffer, with no
  // view per chunk.
  const decoded = decode(bytes);
  assert.equal(decoded.length, chunks);
  assert.ok(decoded.every(byte => byte === 0x41));
  assert.equal(decoded.buffer.byteLength, chunks);
});

test('chunked text: joined once, split characters rejected, replacement as per chunk', () => {
  const chunked = (...chunks) => hex('7f' + chunks.map(chunk => (0x60 + chunk.length / 2).toString(16) + chunk).join('') + 'ff');
  assert.equal(decode(chunked('c3a9', '61', 'e282ac')), 'éa€');
  assert.equal(decode(hex('7f' + '6161'.repeat(20_000) + 'ff')), 'a'.repeat(20_000));
  // A character split across chunks: each chunk must be valid UTF-8 on its own.
  assert.throws(() => decode(chunked('c3', 'a9')), error('invalid-utf8'));
  assert.throws(() => decode(chunked('61', 'a9')), error('invalid-utf8'));
  // Invalid bytes inside a chunk report that chunk's offset.
  assert.throws(() => decode(chunked('61', '62', 'ff')), exception => error('invalid-utf8')(exception) && exception.offset === 6);
  // In replace mode a split character becomes replacement characters, chunk by chunk.
  assert.equal(decode(chunked('c3', 'a9'), { invalidUtf8: 'replace' }), new TextDecoder().decode(hex('c3')) + new TextDecoder().decode(hex('a9')));
  assert.equal(decode(chunked('61ff', '62'), { invalidUtf8: 'replace' }), 'a\ufffdb');
});
