import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, CborError } from '../dist/index.js';

// Vectors brought in from other CBOR decoders. The library already rejects
// these; the tests lock that in.
//
// - RFC 8949 Appendix F.1, as listed by the Rust fcpw suite and the RFC itself
// - ciborium's syntax-error cases (Rust)
// - cbor2's ill-formed indefinite strings, odd indefinite maps, and tag 0/1
//   dates (Python)
// - Jackson's truncated and illegal UTF-8 text (Java), which used to throw
//   ArrayIndexOutOfBoundsException instead of a decode error

const hex = string => Uint8Array.from(Buffer.from(string.replace(/\s/g, ''), 'hex'));
const error = code => exception => exception instanceof CborError && exception.code === code;

function rejects(cases) {
  for (const [wire, code] of cases) assert.throws(() => decode(hex(wire)), error(code), wire);
}

test('RFC 8949 Appendix F.1: not-well-formed items are rejected', () => {
  rejects([
    // End of the input inside a head.
    ['18', 'truncated'], ['19', 'truncated'], ['1a', 'truncated'], ['1b', 'truncated'],
    ['1901', 'truncated'], ['1a0102', 'truncated'], ['1b01020304050607', 'truncated'],
    ['38', 'truncated'], ['58', 'truncated'], ['78', 'truncated'], ['98', 'truncated'],
    ['9a01ff00', 'truncated'], ['b8', 'truncated'], ['d8', 'truncated'], ['f8', 'truncated'],
    ['f900', 'truncated'], ['fa0000', 'truncated'], ['fb000000', 'truncated'],
    // Definite-length strings shorter than their declared length.
    ['41', 'truncated'], ['61', 'truncated'], ['5affffffff00', 'truncated'],
    ['5bffffffffffffffff010203', 'integer-overflow'], ['7affffffff00', 'truncated'],
    ['7b7fffffffffffffff010203', 'integer-overflow'],
    // Definite-length arrays and maps closed too early, and a bare tag.
    ['81', 'truncated'], ['818181818181818181', 'truncated'], ['8200', 'truncated'],
    ['a1', 'truncated'], ['a20102', 'truncated'], ['a100', 'truncated'], ['a2000000', 'truncated'],
    ['c0', 'truncated'],
    // Indefinite-length items with no break.
    ['5f4100', 'truncated'], ['7f6100', 'truncated'], ['9f', 'truncated'], ['9f0102', 'truncated'],
    ['bf', 'truncated'], ['bf01020102', 'truncated'], ['819f', 'truncated'], ['9f8000', 'truncated'],
    ['9f9f9f9f9fffffff', 'truncated'], ['9f819f819f9fffffff', 'truncated'],
    // Reserved additional information, on every major type.
    ['1d', 'invalid-header'], ['1e', 'invalid-header'], ['3c', 'invalid-header'],
    ['3d', 'invalid-header'], ['3e', 'invalid-header'], ['5c', 'invalid-header'],
    ['5d', 'invalid-header'], ['5e', 'invalid-header'], ['7c', 'invalid-header'],
    ['7d', 'invalid-header'], ['7e', 'invalid-header'], ['9c', 'invalid-header'],
    ['9d', 'invalid-header'], ['9e', 'invalid-header'], ['bc', 'invalid-header'],
    ['bd', 'invalid-header'], ['be', 'invalid-header'], ['dc', 'invalid-header'],
    ['dd', 'invalid-header'], ['de', 'invalid-header'], ['fc', 'invalid-header'],
    ['fd', 'invalid-header'], ['fe', 'invalid-header'],
    // Simple values 0..31 encoded in the two-byte form.
    ['f800', 'invalid-header'], ['f801', 'invalid-header'], ['f818', 'invalid-header'],
    // Indefinite-length string chunks of the wrong type, or themselves indefinite.
    ['5f00ff', 'invalid-header'], ['5f21ff', 'invalid-header'], ['5f6100ff', 'invalid-header'],
    ['5f80ff', 'invalid-header'], ['5fa0ff', 'invalid-header'], ['5fc000ff', 'invalid-header'],
    ['5fe0ff', 'invalid-header'], ['7f4100ff', 'invalid-header'],
    ['5f5f4100ffff', 'invalid-header'], ['7f7f6100ffff', 'invalid-header'],
    // A break where a value is required. A definite map whose header already
    // asks for more bytes than remain is reported as truncated.
    ['8200ff', 'invalid-header'], ['a1ff', 'truncated'], ['a1ff00', 'invalid-header'],
    ['a100ff', 'invalid-header'], ['a20000ff', 'truncated'],
    ['9f81ff', 'invalid-header'], ['9f829f819f9fffffffff', 'invalid-header'],
    ['bf00ff', 'invalid-header'], ['bf000000ff', 'invalid-header'],
    // Indefinite-length integers and tags.
    ['1f', 'invalid-header'], ['3f', 'invalid-header'], ['df', 'invalid-header'],
  ]);
});

test('ciborium and cbor2 reject the same ill-formed chunks and maps', () => {
  rejects([
    ['83011f03', 'invalid-header'],       // indefinite integer inside an array
    ['7f616101ff', 'invalid-header'],     // integer chunk in an indefinite text string
    ['7f61614101ff', 'invalid-header'],   // byte-string chunk in an indefinite text string
    ['7f01ff', 'invalid-header'], ['5f01ff', 'invalid-header'],
    ['7f61777f6177ffff', 'invalid-header'], // indefinite chunk nested in a text string
    ['5f41775f4177ffff', 'invalid-header'],
    ['bf6161016162ff', 'invalid-header'], // break after a key, following a finished pair
    // A chunk length whose high 32 bits do not fit in a safe integer.
    ['7f7bff0000000000000471717272ff', 'integer-overflow'],
    ['5f5bff0000000000000471717272ff', 'integer-overflow'],
  ]);
});

test('Jackson UTF-8 cases are a decode error, not an out-of-bounds read', () => {
  rejects([
    ['66ef7d7d0a2dda', 'invalid-utf8'], // truncated multibyte sequence at the end of the text
    ['6461c0af62', 'invalid-utf8'],     // overlong 2-byte, between ASCII
    ['6561e080af62', 'invalid-utf8'],   // overlong 3-byte
    ['6661f08080af62', 'invalid-utf8'], // overlong 4-byte
    ['6561eda08062', 'invalid-utf8'],   // encoded surrogate
    ['6661f490808062', 'invalid-utf8'], // above U+10FFFF
    ['6661f580808062', 'invalid-utf8'], // lead byte that never starts a sequence
    ['6561f0414162', 'invalid-utf8'],   // continuation bytes missing
  ]);
});

test('cbor2 tag 0 and tag 1 dates', () => {
  const instant = text => {
    const bytes = new TextEncoder().encode(text);
    const wire = new Uint8Array(3 + bytes.length);
    wire[0] = 0xc0;
    wire[1] = 0x78;
    wire[2] = bytes.length;
    wire.set(bytes, 3);
    return decode(wire);
  };
  // Same instant cbor2 expects, with the offset applied. JS Date keeps milliseconds.
  assert.equal(instant('2013-03-21T22:04:00+02:00').toISOString(), '2013-03-21T20:04:00.000Z');
  assert.equal(instant('2013-03-21T20:04:00.380841Z').toISOString(), '2013-03-21T20:04:00.380Z');
  assert.equal(instant('2018-08-02T07:00:59+00:30').toISOString(), '2018-08-02T06:30:59.000Z');
  assert.equal(instant('2018-08-02T07:00:59-00:30').toISOString(), '2018-08-02T07:30:59.000Z');
  assert.equal(instant('2018-08-02T07:00:59.1Z').toISOString(), '2018-08-02T07:00:59.100Z');
  assert.throws(() => decode(hex('c06b303030302d3132332d3031')), error('invalid-tag-content')); // 0000-123-01
  // Tag 1 integers past the safe-integer range are not finite JS numbers.
  assert.throws(() => decode(hex('c11b1616161616161616')), error('invalid-tag-content'));
  assert.throws(() => decode(hex('c11b9b9b9b0000000000')), error('invalid-tag-content'));
});

test('a multibyte character straddling the short UTF-8 decoder stays intact', () => {
  // cbor2 issue 264: a character split across a 65536-byte chunk was corrupted.
  // The boundary in this decoder is 32 bytes, so the last character starts at byte 31.
  const euro = new TextEncoder().encode('€');
  const body = new Uint8Array(31 + euro.length);
  body.fill(0x61);
  body.set(euro, 31);
  const wire = new Uint8Array(2 + body.length);
  wire[0] = 0x78;
  wire[1] = body.length;
  wire.set(body, 2);
  const text = decode(wire);
  assert.equal(text.length, 32);
  assert.equal(text.at(-1), '€');
});
