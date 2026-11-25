# Design record: full CBOR data model (pure-cbor 0.5)

Status: **implemented in 0.5.0**. This records the decisions and what measurement changed along the way.

## Scope

Before 0.5, pure-cbor covered the JSON-like core plus typed arrays. 0.5 adds:

1. **Tags:**
   - `Tagged` pass-through for any tag;
   - built-in conversions: dates (0, 1), bignums (2, 3), and unwrapping the self-described marker (55799);
   - caller-supplied decoders via `tags`, which take precedence;
   - `unknownTags: 'reject'` for strictness.
2. **Simple values:** `undefined` (`f7`) and the other simple values (`simple(n)`, as `SimpleValue`).
3. **Integers:** 64-bit values beyond ±2^53 as `bigint`; `bigint` encoding, as integers or as tag 2/3 bignums.
4. **Maps with any keys:** JS `Map` encodes with any keys, and decoding has a `maps` mode (`'auto'` default, `'object'`, `'map'`).
5. **Indefinite-length items on decode:** in the decoder and in the streaming boundary scanner.
6. **Encode options:** `floats: 'shortest'` (RFC 8949 §4.1) and `deterministic: true` (§4.2.1).

## Design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Representing tags and simple values | Immutable values from `tagged()` / `simple()`, recognized by a private prototype | OCaml-style variants. A plain object `{ tag, value }` stays an object, and the plain-object check (`prototype === Object.prototype`) rejects these at no extra cost on the hot path |
| Unknown tags | `Tagged` by default | Lossless pass-through, as cbor-x and cbor2 do; strictness is opt-in |
| Dates | Encode as tag 1 (epoch seconds); decode tags 0 and 1, rounding to the millisecond | A `Date` holds whole milliseconds. Rounding undoes the float error of `ms / 1000 * 1000`; a test caught a one-millisecond drift |
| Integers beyond 2^53 | `bigint` | Previously an error. Safe-range bigints decode as numbers, because CBOR has one integer type |
| Map decoding | `'auto'`: objects for all-text keys, else `Map`; switches mid-map, keeping order | Keeps the fast object path for normal data, while COSE/CWT-style integer keys just work |
| `undefined` | `f7` in arrays, `Map` values and at top level; omitted as an object property | JSON parity for objects; explicit elsewhere |
| Indefinite lengths | Decode only | Some encoders emit them; emitting them has no benefit for this library |
| Shortest floats and deterministic encoding | Opt-in | They cost a width check per float and, for deterministic, a sort per map |

## Performance: what measurement changed

Every change was checked against the 0.4.0 build: different processes, plus an in-process A/B harness that alternates 30 ms bursts of two builds, calibrated at 1.00 with identical builds. That harness mattered because another process was loading a core during this work.

| Finding | Change |
| --- | --- |
| Reading encode options per object (`writer.sortKeys`, `writer.shortestFloats`) cost ~10% on small-object encode | Options don't live on the writer. They select the write function once per call (`writerFor`): the default writer never checks them, and a separate plain recursive writer handles shortest floats and sorted keys |
| An unused `shortestFloats` parameter on `NumberCodec.write` slowed integer-array encode ~5% (V8 inlining) | Two functions: `write` (default) and `writeShortest` |
| `Map` lookup of the writer on every `encode()` | Returns immediately for the default profile |
| Map decode split into helpers (`readIntoObject`, per-entry `moreEntries`/`readEntryValue`) made small-object decode bimodal: half the processes ran 40% slower | The object loop lives in `map.read` itself, testing `index < count` inline; helpers are only used for `Map` and indefinite maps |
| A shared `readString` returning a `[value, end]` pair allocated on every text decode (+10% on short strings) | Definite text is decoded inline; the helper serves byte strings and chunked text |
| Two "cleaner" refactors (an `encode` wrapper, a `readUnsigned` helper) measured 1.2–1.3× slower | Reverted |

Net, in the A/B against 0.4.0:

- **Faster:** object rows encode 8–9% faster and decode 4–7% faster.
- **Level:** nested configs, floats, strings and typed arrays.
- **Slower:**
  - integer-array decode is +2–3%, one comparison per element so 64-bit values can become `bigint`;
  - small-integer `encode()` is +2 ns (about 7% of 25 ns). Every alternative I tried was slower.

## Verification

- All of **RFC 8949 Appendix A** decodes. Every example JS can represent exactly also encodes back to the same bytes; integral floats like 1.0 are JS integers, so they encode as integers.
- **Deterministic output equals cborg's canonical encoding byte for byte** on cbor-x's example4.json, @msgpack/msgpack's sample-large.json and 50 Bluesky-style records.
- **RFC 8949 §4.2.1 key order:** the RFC's example order is reproduced from 20 shuffled insertion orders.
- **Interop with cbor-x** for dates, bigints, `Map` and `undefined`, in both directions.
- **Random trees** with every value kind (bigint, Date, `Map` with byte-string keys, `Tagged`, simple values) round-trip in all three encode modes, and `encodedSize` agrees with the output.
- **Malformed input:** 30,000 random inputs built from the new forms yield only values or `CborError`s, and malformed indefinite and simple-value forms report the same error code under every stream chunking.
