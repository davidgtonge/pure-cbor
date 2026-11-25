// pure-cbor vs the engine's built-in JSON, on every workload JSON represents
// exactly. JSON is measured two ways:
//   string: JSON.stringify / JSON.parse alone (data already a JS string)
//   bytes:  stringify + TextEncoder / TextDecoder + parse, i.e. what crosses a
//           socket or a file, comparable to CBOR's Uint8Array in and out.
// Each workload runs in its own process. Usage: node bench/json.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { encode, decode } from '../dist/index.js';
import { cases } from './cases.mjs';

const durationMs = Number(process.env.BENCH_MS || 80);
const rounds = Number(process.env.BENCH_ROUNDS || 5);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let sink = 0;

/** Median ns per call over `rounds` timed runs, after a warm-up run. */
function measure(run, batch) {
  const timeRun = duration => {
    let calls = 0;
    const start = performance.now();
    let now = start;
    do {
      for (let index = 0; index < batch; index++) sink = (sink + run(calls + index)) | 0;
      calls += batch;
      now = performance.now();
    } while (now - start < duration);
    return (now - start) * 1e6 / calls;
  };
  timeRun(Math.min(100, durationMs));
  const results = Array.from({ length: rounds }, () => timeRun(durationMs)).sort((a, b) => a - b);
  return results[Math.floor(results.length / 2)];
}

const consume = value => (value === null || typeof value !== 'object' ? 1 : Array.isArray(value) ? value.length : 2);

function jsonExact(values) {
  // Typed arrays are never JSON-exact; skip them before deepStrictEqual, whose
  // failure message for a 1 MiB array exhausted memory.
  if (values.some(value => ArrayBuffer.isView(value))) return false;
  return values.every(value => isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value));
}

function runWorkload(name) {
  const values = cases.find(([caseName]) => caseName === name)[1];
  const mask = values.length - 1;
  const cbor = values.map(value => encode(value));
  const json = values.map(value => JSON.stringify(value));
  const jsonBytes = json.map(text => encoder.encode(text));
  const batch = cbor[0].length > 65536 ? 8 : cbor[0].length > 1024 ? 128 : 512;
  const fresh = cbor[0].length <= 65536;
  const results = {
    'cbor encode': measure(index => encode(values[index & mask]).length, batch),
    'json stringify': measure(index => JSON.stringify(values[index & mask]).length, batch),
    'json encode bytes': measure(index => encoder.encode(JSON.stringify(values[index & mask])).length, batch),
    'cbor decode': measure(index => consume(decode(cbor[index & mask])), batch),
    'json parse': measure(index => consume(JSON.parse(json[index & mask])), batch),
    'json decode bytes': measure(index => consume(JSON.parse(decoder.decode(jsonBytes[index & mask]))), batch),
  };
  if (fresh) {
    results['cbor decode fresh'] = measure(index => consume(decode(cbor[index & mask].slice())), batch);
    results['json decode fresh bytes'] = measure(index => consume(JSON.parse(decoder.decode(jsonBytes[index & mask].slice()))), batch);
  }
  results.cborBytes = cbor.reduce((total, bytes) => total + bytes.length, 0) / cbor.length;
  results.jsonBytes = jsonBytes.reduce((total, bytes) => total + bytes.length, 0) / jsonBytes.length;
  console.log(JSON.stringify(results));
}

if (process.env.JSON_WORKLOAD) {
  runWorkload(process.env.JSON_WORKLOAD);
} else {
  const self = fileURLToPath(import.meta.url);
  const included = cases.filter(([, values]) => jsonExact(values)).map(([name]) => name);
  const skipped = cases.map(([name]) => name).filter(name => !included.includes(name));
  const results = new Map();
  for (const name of included) {
    process.stderr.write(`${name}\n`);
    const output = execFileSync(process.execPath, [self], { env: { ...process.env, JSON_WORKLOAD: name }, encoding: 'utf8' });
    results.set(name, JSON.parse(output.trim().split('\n').at(-1)));
  }
  const format = ns => ns === undefined ? '–' : ns >= 10000 ? `${(ns / 1000).toFixed(1)} µs` : `${ns.toFixed(0)} ns`;
  const ratio = (json, cbor) => json === undefined ? '–' : `${(json / cbor).toFixed(2)}×`;
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}. Each workload in its own process; median of ${rounds} rounds.`);
  console.log('Ratios are JSON time divided by pure-cbor time: above 1 means pure-cbor is faster.');
  console.log(`Skipped (JSON cannot represent them exactly): ${skipped.join(', ')}.`);
  const table = (title, cborKey, stringKey, bytesKey) => {
    console.log(`\n### ${title}\n`);
    console.log('| Workload | pure-cbor | JSON (string) | vs string | JSON (bytes) | vs bytes |');
    console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const [name, r] of results) {
      if (r[cborKey] === undefined) continue;
      console.log(`| ${name} | ${format(r[cborKey])} | ${format(r[stringKey])} | ${ratio(r[stringKey], r[cborKey])} | ${format(r[bytesKey])} | ${ratio(r[bytesKey], r[cborKey])} |`);
    }
  };
  table('Encode', 'cbor encode', 'json stringify', 'json encode bytes');
  table('Decode (reused input)', 'cbor decode', 'json parse', 'json decode bytes');
  console.log('\n### Decode (fresh input bytes)\n');
  console.log('| Workload | pure-cbor | JSON (bytes) | vs bytes |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const [name, r] of results) {
    if (r['cbor decode fresh'] === undefined) continue;
    console.log(`| ${name} | ${format(r['cbor decode fresh'])} | ${format(r['json decode fresh bytes'])} | ${ratio(r['json decode fresh bytes'], r['cbor decode fresh'])} |`);
  }
  console.log('\n### Size\n');
  console.log('| Workload | CBOR bytes | JSON bytes | CBOR / JSON |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const [name, r] of results) {
    console.log(`| ${name} | ${Math.round(r.cborBytes).toLocaleString('en')} | ${Math.round(r.jsonBytes).toLocaleString('en')} | ${(r.cborBytes / r.jsonBytes * 100).toFixed(0)}% |`);
  }
}
