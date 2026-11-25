// Streaming benchmark: CBOR sequences through pure-cbor's incremental decoder,
// its Web Streams adapters, and cbor-x's Node-stream DecoderStream/EncoderStream.
// Every variant runs in its own process. Each run slices fresh chunk buffers
// (as a network stream delivers them) inside the timed region, for every variant.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  encode, decode, createSequenceDecoder, createSequenceEncoder, decodeStream, encodeStream, decodeSequence,
} from '../dist/index.js';
import { floatMesh } from './corpus/generate.mjs';

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = 'true';
const rounds = Number(process.env.BENCH_ROUNDS || 5);
const ROW_COUNT = 100_000;
const row = index => ({ id: index, name: `user_${index}`, active: index % 2 === 0, score: index + 0.5, email: null, tags: ['a', 'b'] });

const concat = parts => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const freshChunks = (bytes, size) => {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.slice(offset, offset + size));
  return chunks;
};
// Pull-based sources: enqueuing everything up front makes Node's stream queue
// quadratic (100,000 pre-enqueued items took 2.7 s just to read back).
const pullFrom = items => {
  let index = 0;
  return new ReadableStream({ pull(controller) { if (index < items.length) controller.enqueue(items[index++]); else controller.close(); } });
};
const fromChunks = pullFrom;

async function loadReference() {
  try { return await import('cbor-x'); } catch { return undefined; }
}

/** Each variant returns an async function performing one full run; it must return the item count. */
async function variants() {
  const reference = await loadReference();
  const rows = Array.from({ length: ROW_COUNT }, (_, index) => row(index));
  const rowBytes = concat(rows.map(value => encode(value)));
  const mesh = floatMesh(60_000, 7); // ~8 MB, one item
  const meshBytes = encode(mesh);
  const decodeCases = [
    ['decode 100k rows, 64 KiB chunks', rowBytes, 65536, ROW_COUNT],
    ['decode 100k rows, 1 KiB chunks', rowBytes, 1024, ROW_COUNT],
    ['decode 8 MiB mesh, 16 KiB chunks', meshBytes, 16384, 1],
  ];
  // Reference point: the same items decoded one by one with decode(), already
  // separated, so no chunk boundaries (each from a fresh copy, like a message).
  const rowItems = rows.map(value => encode(value));
  const perItem = expected => expected === 1
    ? async () => { decode(meshBytes.slice()); return 1; }
    : async () => { for (const item of rowItems) decode(item.slice()); return rowItems.length; };
  const list = {};
  for (const [name, bytes, size, expected] of decodeCases) {
    list[`${name} | pure-cbor decode() per item (no streaming)`] = perItem(expected);
    list[`${name} | pure-cbor sequence decoder`] = async () => {
      const decoder = createSequenceDecoder();
      let count = 0;
      const onValue = () => { count++; };
      for (const chunk of freshChunks(bytes, size)) decoder.push(chunk, onValue);
      decoder.end();
      return count;
    };
    list[`${name} | pure-cbor decodeStream (Web Streams)`] = async () => {
      let count = 0;
      for await (const _ of fromChunks(freshChunks(bytes, size)).pipeThrough(decodeStream())) count++;
      return count;
    };
    list[`${name} | pure-cbor decodeStream (Web Streams), batch`] = async () => {
      let count = 0;
      for await (const batch of fromChunks(freshChunks(bytes, size)).pipeThrough(decodeStream({ batch: true }))) count += batch.length;
      return count;
    };
    list[`${name} | pure-cbor decodeSequence (async iterator)`] = async () => {
      let count = 0;
      for await (const _ of decodeSequence(freshChunks(bytes, size))) count++;
      return count;
    };
    if (reference) {
      list[`${name} | cbor-x DecoderStream (Node streams)`] = async () => {
        let count = 0;
        const decoder = new reference.DecoderStream({ useRecords: false });
        const done = new Promise((resolve, reject) => { decoder.on('data', () => { count++; }); decoder.on('end', resolve); decoder.on('error', reject); });
        Readable.from(freshChunks(bytes, size)).pipe(decoder);
        await done;
        return count;
      };
    }
  }
  const rowBatches = [];
  for (let index = 0; index < rows.length; index += 1000) rowBatches.push(rows.slice(index, index + 1000));
  for (const chunkBytes of [0, 16384]) {
    list[`encode 100k rows | pure-cbor encodeStream (Web Streams), batches of 1000, chunkBytes ${chunkBytes}`] = async () => {
      let bytes = 0;
      for await (const chunk of pullFrom(rowBatches).pipeThrough(encodeStream({ batch: true, chunkBytes }))) bytes += chunk.length;
      return bytes === rowBytes.length ? ROW_COUNT : -1;
    };
  }
  for (const chunkBytes of [0, 16384]) {
    list[`encode 100k rows | pure-cbor sequence encoder, chunkBytes ${chunkBytes}`] = async () => {
      const encoder = createSequenceEncoder({ chunkBytes });
      let bytes = 0;
      const onChunk = chunk => { bytes += chunk.length; };
      for (const value of rows) encoder.push(value, onChunk);
      encoder.flush(onChunk);
      return bytes === rowBytes.length ? ROW_COUNT : -1;
    };
    list[`encode 100k rows | pure-cbor encodeStream (Web Streams), chunkBytes ${chunkBytes}`] = async () => {
      let bytes = 0;
      const source = pullFrom(rows);
      for await (const chunk of source.pipeThrough(encodeStream({ chunkBytes }))) bytes += chunk.length;
      return bytes === rowBytes.length ? ROW_COUNT : -1;
    };
  }
  if (reference) {
    list['encode 100k rows | cbor-x EncoderStream (Node streams)'] = async () => {
      let bytes = 0;
      const encoder = new reference.EncoderStream({ useRecords: false });
      const done = new Promise((resolve, reject) => { encoder.on('data', chunk => { bytes += chunk.length; }); encoder.on('end', resolve); encoder.on('error', reject); });
      Readable.from(rows).pipe(encoder);
      await done;
      return bytes > 0 ? ROW_COUNT : -1;
    };
  }
  return { list, sizes: { rows: rowBytes.length, mesh: meshBytes.length } };
}

async function runOne(name) {
  const { list } = await variants();
  const job = list[name];
  await job(); // warm up
  await job();
  const times = [];
  let count = 0;
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    count = await job();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ name, ms: times[Math.floor(times.length / 2)], count }));
}

if (process.env.STREAM_VARIANT) {
  await runOne(process.env.STREAM_VARIANT);
} else {
  const { list, sizes } = await variants();
  const self = fileURLToPath(import.meta.url);
  const results = [];
  for (const name of Object.keys(list)) {
    process.stderr.write(`${name}\n`);
    const output = execFileSync(process.execPath, [self], { env: { ...process.env, STREAM_VARIANT: name }, encoding: 'utf8' });
    results.push(JSON.parse(output.trim().split('\n').at(-1)));
  }
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}. Each variant in its own process; median of ${rounds} runs.`);
  console.log(`Row sequence: ${(sizes.rows / 1e6).toFixed(1)} MB, ${ROW_COUNT.toLocaleString('en')} items. Mesh: ${(sizes.mesh / 1e6).toFixed(1)} MB, one item.\n`);
  let group;
  for (const { name, ms, count } of results) {
    const [workload, variant] = name.split(' | ');
    if (workload !== group) {
      group = workload;
      console.log(`\n### ${workload}\n\n| Variant | Time | MB/s |\n| --- | ---: | ---: |`);
    }
    const megabytes = (workload.includes('mesh') ? sizes.mesh : sizes.rows) / 1e6;
    const valid = count > 0 ? '' : ' (count mismatch!)';
    console.log(`| ${variant}${valid} | ${ms.toFixed(1)} ms | ${(megabytes / (ms / 1000)).toFixed(0)} |`);
  }
}
