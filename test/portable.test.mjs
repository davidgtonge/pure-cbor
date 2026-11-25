// The portable suite under node:test, so `npm test` runs it too. Other
// runtimes run it through test/portable/run.mjs, browsers.mjs and workerd.mjs.
import { test } from 'node:test';
import { cases } from './portable/suite.mjs';

for (const { name, run } of cases) test(`portable: ${name}`, run);
