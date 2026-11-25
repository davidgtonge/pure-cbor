// The portable suite as a Cloudflare Worker module, for workerd (run by
// test/portable/miniflare.mjs). Every request runs the suite and answers with
// its summary as JSON.
import { runSuite } from './suite.mjs';

export default {
  async fetch() {
    return Response.json(await runSuite());
  },
};
