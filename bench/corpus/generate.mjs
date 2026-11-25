// Seeded generators for benchmark data shaped like the workloads other CBOR
// suites use: string-heavy social records (as in cborg's Bluesky fixtures)
// and float-heavy geometry (as in rust_serialization_benchmark's mesh).
// Written for this repo; deterministic for a given seed.

/** Small deterministic PRNG (xorshift32); returns floats in [0, 1). */
export function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const WORDS = ['the', 'a', 'new', 'post', 'about', 'cbor', 'today', 'great', 'thread', 'release',
  'reading', 'coffee', 'weekend', 'photo', 'link', 'thanks', 'everyone', 'shipping', 'data', 'fast'];

function generators(random) {
  const integer = limit => Math.floor(random() * limit);
  const pick = list => list[integer(list.length)];
  const token = length => Array.from({ length }, () => ALPHABET[integer(ALPHABET.length)]).join('');
  const did = () => `did:plc:${token(24)}`;
  const recordKey = () => token(13);
  const cid = () => `bafyrei${token(52)}`; // CIDs as strings, as in JSON exports
  const timestamp = () => new Date(Date.UTC(2026, integer(12), 1 + integer(28), integer(24), integer(60), integer(60))).toISOString();
  const sentence = () => Array.from({ length: 4 + integer(30) }, () => pick(WORDS)).join(' ');
  const strongRef = collection => ({ uri: `at://${did()}/${collection}/${recordKey()}`, cid: cid() });
  return { integer, pick, did, cid, timestamp, sentence, strongRef };
}

/** A mixed feed of Bluesky-style records: posts (some replies, some with
 * facets), likes, reposts and follows. */
export function blueskyRecords(count, seed = 12345) {
  const random = seededRandom(seed);
  const { integer, did, timestamp, sentence, strongRef } = generators(random);
  const records = [];
  for (let index = 0; index < count; index++) {
    const kind = integer(10);
    if (kind < 5) {
      const text = sentence();
      const post = { $type: 'app.bsky.feed.post', text, createdAt: timestamp(), langs: ['en'] };
      if (integer(3) === 0) post.reply = { root: strongRef('app.bsky.feed.post'), parent: strongRef('app.bsky.feed.post') };
      if (integer(4) === 0) {
        const start = integer(Math.max(1, text.length - 5));
        post.facets = [{
          index: { byteStart: start, byteEnd: start + 5 },
          features: [{ $type: 'app.bsky.richtext.facet#mention', did: did() }],
        }];
      }
      records.push(post);
    } else if (kind < 8) {
      records.push({ $type: 'app.bsky.feed.like', subject: strongRef('app.bsky.feed.post'), createdAt: timestamp() });
    } else if (kind < 9) {
      records.push({ $type: 'app.bsky.feed.repost', subject: strongRef('app.bsky.feed.post'), createdAt: timestamp() });
    } else {
      records.push({ $type: 'app.bsky.graph.follow', subject: did(), createdAt: timestamp() });
    }
  }
  return records;
}

/** A triangle mesh: each triangle has three [x, y, z] vertices and a normal. */
export function floatMesh(triangleCount, seed = 12345) {
  const random = seededRandom(seed);
  const point = () => [random() * 200 - 100, random() * 200 - 100, random() * 200 - 100];
  const triangles = [];
  for (let index = 0; index < triangleCount; index++) {
    triangles.push({ vertices: [point(), point(), point()], normal: point() });
  }
  return { name: `mesh-${seed}`, triangles };
}

/** A flat array of non-integer numbers. */
export function floatArray(length, seed = 12345) {
  const random = seededRandom(seed);
  return Array.from({ length }, () => random() * 1e6 - 5e5);
}
