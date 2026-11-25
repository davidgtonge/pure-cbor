// Benchmark workloads, shared by bench.mjs and json.mjs. Each workload is a
// name and a few values to rotate through (16 for small values, 2 for large).
import { readFileSync } from 'node:fs';
import { blueskyRecords, floatMesh, floatArray } from './corpus/generate.mjs';

const corpusFile = name => JSON.parse(readFileSync(new URL(`./corpus/${name}`, import.meta.url), 'utf8'));
const row = index => ({ id: index, name: `user_${index}`, active: index % 2 === 0, score: index + 0.5, email: null, tags: ['a', 'b'] });
const sixteen = make => Array.from({ length: 16 }, (_, index) => make(index));

export const cases = [
  ['uint small', sixteen(index => index)],
  ['mixed integers', sixteen(index => index % 2 ? -100000 - index : index * 100000)],
  ['timestamp', sixteen(index => 1732435200000 + index)],
  ['float64', sixteen(index => Math.PI * (index + 1))],
  ['boolean/null', sixteen(index => [true, false, null][index % 3])],
  ['ASCII 8', sixteen(index => `field_${index.toString(16)}x`)],
  ['ASCII 32', sixteen(index => 'x'.repeat(31) + index.toString(16))],
  ['ASCII 64', sixteen(index => 'x'.repeat(63) + index.toString(16))],
  ['Unicode 32', sixteen(index => 'é水😀'.repeat(8) + index.toString(16))],
  ['ASCII 4096', sixteen(index => 'x'.repeat(4095) + index.toString(16))],
  ['number[] 128', sixteen(index => Array.from({ length: 128 }, (_, j) => index + j))],
  ['string[] 128', sixteen(index => Array.from({ length: 128 }, (_, j) => `f_${index}_${j}`))],
  ['mixed[] 128', sixteen(index => Array.from({ length: 128 }, (_, j) => [j, `f_${j}`, j % 2 === 0, null][(index + j) % 4]))],
  ['number[] 10000', Array.from({ length: 2 }, (_, index) => Array.from({ length: 10000 }, (_, j) => index + j))],
  ['Float64Array 1 KiB', sixteen(index => new Float64Array(128).fill(index + 0.5))],
  ['Float64Array 1 MiB', Array.from({ length: 2 }, (_, index) => new Float64Array(131072).fill(index + 0.5))],
  ['object: row', sixteen(index => row(index))],
  ['object: 100 rows', Array.from({ length: 2 }, (_, index) => Array.from({ length: 100 }, (_, j) => row(index * 100 + j)))],
  ['object: nested config', sixteen(index => ({ meta: { version: index, source: 'api' },
    items: Array.from({ length: 20 }, (_, j) => ({ k: `k${j}`, v: j })) }))],
  // Public data from other libraries' own benchmarks, and shapes from other CBOR suites (see corpus/README.md).
  ['corpus: cbor-x example4', sixteen(() => corpusFile('cbor-x-example4.json'))],
  ['corpus: msgpack sample-large', sixteen(() => corpusFile('msgpack-sample-large.json'))],
  ['corpus: bluesky records 100', sixteen(index => blueskyRecords(100, 1000 + index))],
  ['corpus: float mesh 1000', Array.from({ length: 2 }, (_, index) => floatMesh(1000, 2000 + index))],
  ['corpus: float[] 10000', Array.from({ length: 2 }, (_, index) => floatArray(10000, 3000 + index))],
];

