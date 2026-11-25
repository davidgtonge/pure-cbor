// The portable suite inside a module web worker; posts its summary back.
import { runSuite } from './suite.mjs';

self.postMessage(await runSuite());
