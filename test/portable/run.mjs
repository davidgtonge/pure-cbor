// Runs the portable suite from a command line: node, deno or bun.
//   node test/portable/run.mjs
//   deno run test/portable/run.mjs
//   bun test/portable/run.mjs
import { runSuite } from './suite.mjs';

const runtime = globalThis.Deno ? `Deno ${Deno.version.deno}`
  : globalThis.Bun ? `Bun ${Bun.version}`
  : `Node ${globalThis.process?.versions?.node}`;

const { passed, failed, results } = await runSuite();
for (const result of results) {
  console.log(`${result.ok ? 'ok' : 'not ok'}  ${result.name} (${result.milliseconds} ms)`);
  if (!result.ok) console.log(result.error.replace(/^/gm, '    '));
}
console.log(`${runtime}: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  if (globalThis.Deno) Deno.exit(1);
  else globalThis.process.exitCode = 1;
}
