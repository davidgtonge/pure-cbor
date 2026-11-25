import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode, encodedSize, encodeInto } from '../dist/index.js';
import { blueskyRecords, floatMesh, floatArray } from '../bench/corpus/generate.mjs';

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = 'true';
const optional = async name => {
  try { return await import(name); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
};
const cborX = await optional('cbor-x');
const cborg = await optional('cborg');

const corpusFile = name => JSON.parse(readFileSync(new URL(`../bench/corpus/${name}`, import.meta.url), 'utf8'));
const corpus = [
  ['cbor-x example4', corpusFile('cbor-x-example4.json')],
  ['msgpack sample-large', corpusFile('msgpack-sample-large.json')],
  ['bluesky records', blueskyRecords(200, 7)],
  ['float mesh', floatMesh(200, 7)],
  ['float array', floatArray(2000, 7)],
];

test('public and generated corpus round trips exactly', () => {
  for (const [name, value] of corpus) {
    const bytes = encode(value);
    assert.deepEqual(decode(bytes), value, name);
    assert.equal(bytes.length, encodedSize(value), name);
    const destination = new Uint8Array(bytes.length);
    assert.equal(encodeInto(value, destination), bytes.length, name);
    assert.deepEqual(destination, bytes, name);
  }
});

test('cbor-x reads our corpus output, and we read its', { skip: !cborX }, () => {
  const encoder = new cborX.Encoder({ useRecords: false });
  const decoder = new cborX.Decoder({ useRecords: false, int64AsNumber: true });
  for (const [name, value] of corpus) {
    assert.deepEqual(decoder.decode(encode(value)), value, name);
    assert.deepEqual(decode(encoder.encode(value)), value, name);
  }
});

test('cborg reads our corpus output, and we read its', { skip: !cborg }, () => {
  for (const [name, value] of corpus) {
    assert.deepEqual(cborg.decode(encode(value)), value, name);
    assert.deepEqual(decode(cborg.encode(value)), value, name);
  }
});
