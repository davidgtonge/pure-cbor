// Runs every bench.mjs workload in its own Node process and prints markdown
// tables comparing cbor-fp with every installed library (see libraries.mjs).
// Workloads sharing one process skew each other's V8 type feedback, which
// made earlier cross-workload comparisons unreliable.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const benchPath = fileURLToPath(new URL('./bench.mjs', import.meta.url));
const run = env => execFileSync(process.execPath, [benchPath], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 26 });
const escape = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const { workloads, libraries } = JSON.parse(run({ BENCH_LIST: '1' }));
const only = process.env.ISOLATED_FILTER ? new RegExp(process.env.ISOLATED_FILTER) : undefined;
const results = new Map();
for (const workload of workloads) {
  if (only && !only.test(workload)) continue;
  process.stderr.write(`${workload}\n`);
  const rows = JSON.parse(run({ BENCH_JSON: '1', BENCH_FILTER: `^${escape(workload)}$` }));
  results.set(workload, Object.fromEntries(rows.map(row => [row.method, row['ns/op']])));
}

const format = ns => ns === undefined ? '–' : ns >= 10000 ? `${(ns / 1000).toFixed(1)} µs` : `${ns.toFixed(0)} ns`;
const ratio = (best, ours) => best === undefined || ours === undefined ? '–' : `${(best / ours).toFixed(2)}×`;
const operations = [
  ['Encode (owned output)', 'encode owned'],
  ['Decode (reused input)', 'decode'],
  ['Decode (fresh input)', 'decode fresh'],
];
const cborLibraries = libraries.filter(library => library.format === 'CBOR').map(library => library.name);

console.log(`Node ${process.version}, ${process.platform}/${process.arch}. Each workload in its own process; median of ${process.env.BENCH_ROUNDS || 3} rounds.`);
console.log(`Libraries: ${libraries.map(library => `${library.name} (${library.format})`).join(', ')}. "–" means the library cannot round-trip that workload exactly.`);
console.log('Ratios are the fastest other library\'s time divided by cbor-fp\'s: above 1 means cbor-fp is faster.');
for (const [title, suffix] of operations) {
  console.log(`\n### ${title}\n`);
  const names = libraries.map(library => library.name);
  console.log(`| Workload | cbor-fp | ${names.join(' | ')} | vs best CBOR | vs best overall |`);
  console.log(`| --- | ---: |${' ---: |'.repeat(names.length + 2)}`);
  for (const [workload, methods] of results) {
    const ours = methods[suffix];
    if (ours === undefined) continue;
    const time = name => methods[`${name} ${suffix}`];
    const fastest = list => {
      const times = list.map(time).filter(value => value !== undefined);
      return times.length ? Math.min(...times) : undefined;
    };
    const cells = names.map(name => format(time(name)));
    console.log(`| ${workload} | ${format(ours)} | ${cells.join(' | ')} | ${ratio(fastest(cborLibraries), ours)} | ${ratio(fastest(names), ours)} |`);
  }
}
