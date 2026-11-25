# Benchmark corpus

Public data used by other libraries' own benchmarks, plus seeded generators for the shapes other CBOR suites test. The benchmark verifies that every workload round-trips exactly, and reads back identically in cbor-x and cborg, before timing it.

| File | Source | License | Shape |
| --- | --- | --- | --- |
| `cbor-x-example4.json` | [kriszyp/cbor-x `tests/example4.json`](https://github.com/kriszyp/cbor-x/blob/master/tests/example4.json), the data cbor-x's own benchmark uses | MIT (cbor-x) | One 7.5 KB clinical-trial document: 53 objects, 69 arrays, 7 levels deep, 59 floats, strings up to 282 characters |
| `msgpack-sample-large.json` | [msgpack/msgpack-javascript `benchmark/sample-large.json`](https://github.com/msgpack/msgpack-javascript/blob/main/benchmark/sample-large.json) | ISC (msgpack-javascript) | 13 podcast-feed records, 9.8 KB, strings up to 578 characters |
| `generate.mjs` | This repo | Same as this repo | Seeded generators: Bluesky-style records (shaped like cborg's string-heavy fixtures, with DIDs, AT-URIs and CIDs as strings, since tag 42 is unsupported), a float triangle mesh (like rust_serialization_benchmark's mesh), and flat float arrays |

Downloaded on 2026-11-24. The files are unmodified copies; see each upstream repository for its full license text.
