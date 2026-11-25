import { performance } from 'node:perf_hooks';
import { deepStrictEqual } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { binary, encode, decode, write, readWhole, maxEncodedSize, createSlabEncoder } from '../dist/index.js';
import { cases } from './cases.mjs';

import { loadLibraries } from './libraries.mjs';

const libraries = await loadLibraries();

const durationMs = Number(process.env.BENCH_MS || 100);
const rounds = Number(process.env.BENCH_ROUNDS || 3);
const filter = process.env.BENCH_FILTER ? new RegExp(process.env.BENCH_FILTER) : undefined;
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

/** Touch a decoded value so the work cannot be optimized away. */
function consume(value) {
  if (typeof value === 'number') return value | 0;
  if (typeof value === 'string') return value.length;
  if (value === null || typeof value === 'boolean') return 1;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return value.length;
  return Object.keys(value).length;
}


if (process.env.BENCH_LIST) {
  console.log(JSON.stringify({ workloads: cases.map(([name]) => name), libraries: libraries.map(({ name, format }) => ({ name, format })) }));
  process.exit(0);
}

const rows = [];
function bench(workload, method, run, batch) {
  const ns = measure(run, batch);
  rows.push({ workload, method, 'ns/op': Number(ns.toFixed(1)) });
}

/** Whether `library` reproduces every value of a workload exactly in its own
 * round trip (any failure or difference means "not supported"). A boolean
 * comparison: assert's failure message for a 1 MiB typed array exhausted memory. */
function supports(library, values) {
  try {
    return values.every(value => isDeepStrictEqual(library.normalize(library.decode(library.encode(library.prepare(value)))), value));
  } catch {
    return false;
  }
}

for (const [name, values] of cases) {
  if (filter && !filter.test(name)) continue;
  for (const value of values) deepStrictEqual(decode(encode(value)), value, `${name}: cbor-fp round trip`);
  const mask = values.length - 1;
  const largest = Math.max(...values.map(value => maxEncodedSize(value)));
  const batch = largest > 65536 ? 8 : largest > 1024 ? 128 : 512;
  const prepared = binary(new Uint8Array(largest));
  const encoded = values.map(value => encode(value));
  const inputs = encoded.map(binary);
  const fresh = largest <= 65536;
  const pooled = createSlabEncoder();

  bench(name, 'encode owned', index => encode(values[index & mask]).length, batch);
  bench(name, 'encode slab', index => pooled(values[index & mask]).length, batch);
  bench(name, 'write prepared', index => write(prepared, 0, values[index & mask]), batch);
  bench(name, 'decode', index => consume(decode(encoded[index & mask])), batch);
  if (fresh) bench(name, 'decode fresh', index => consume(decode(encoded[index & mask].slice())), batch);
  bench(name, 'readWhole prepared', index => consume(readWhole(inputs[index & mask])), batch);

  for (const library of libraries) {
    if (!supports(library, values)) continue;
    const native = values.map(library.prepare);
    const own = native.map(value => library.encode(value));
    const sizeOf = output => output.byteLength;
    bench(name, `${library.name} encode owned`, index => sizeOf(library.encode(native[index & mask])), batch);
    bench(name, `${library.name} decode`, index => consume(library.decode(own[index & mask])), batch);
    if (fresh) bench(name, `${library.name} decode fresh`, index => consume(library.decode(library.fresh(own[index & mask]))), batch);
  }
}

if (process.env.BENCH_JSON) {
  console.log(JSON.stringify(rows));
} else {
  console.log(`Node ${process.version}; ${rounds} rounds x >=${durationMs}ms (median); compared with: ${libraries.map(library => library.name).join(', ') || 'nothing installed'}`);
  console.table(rows);
  console.log('Checksum:', sink);
  console.log('For comparisons across workloads use bench/isolated.mjs: one process per workload.');
}
