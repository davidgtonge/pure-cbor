# pure-cbor vs cbor-x and cborg

Versions before 1.0.0 were named cbor-fp.

Node v22.19.0, macOS arm64. Main tables: pure-cbor 0.5.0 (0.6.0 changed only byte-string copying and `Map`/byte-string encoding; see the flows section). Measured with the machine otherwise idle (load average about 2.4).

**Libraries:**
- **cbor-x**: pure JS (native string extraction disabled), in standard CBOR mode (`useRecords: false`).
- **cborg**: default options. It sorts map keys and writes floats at their smallest exact width, which is extra work pure-cbor and cbor-x don't do.

**Method:**
- Each workload runs in its **own Node process**. Workloads sharing a process skewed each other's V8 type feedback by up to 2×.
- Median of 5 × 80 ms rounds.
- Before timing, every workload is checked to round-trip exactly through pure-cbor and to read back identically in cbor-x and cborg.
- Each library decodes its own encoding of the same value.

**Columns:**
- **Encode (owned):** an independently owned `Uint8Array`; for cbor-x, `Uint8Array.from(encoder.encode(v))`, since its plain `encode()` returns a view into a reused buffer.
- **Decode (reused):** the same input buffer every call.
- **Decode (fresh):** a new copy every call, like a just-received message (only timed for inputs up to 64 KiB).
- **vs best other:** the faster of cbor-x and cborg divided by pure-cbor; above 1 means pure-cbor is faster.

Reproduce:

```sh
npm install --no-save --package-lock=false cbor-x cborg
BENCH_MS=80 BENCH_ROUNDS=5 npm run bench:isolated
```

## Workloads

| Group | Workloads |
| --- | --- |
| Scalars and text | Integers, a millisecond timestamp, float64, booleans/null, ASCII of 8–4096 bytes, Unicode |
| Arrays | 128 integers, 128 short strings, 128 mixed (number, string, boolean, null), 10,000 integers |
| Typed arrays | `Float64Array` of 1 KiB and 1 MiB (cborg doesn't encode typed arrays) |
| Objects | One row `{ id, name, active, score, email: null, tags }`, 100 rows, a nested config `{ meta, items: [20 × { k, v }] }` |
| **Public corpus** (see [bench/corpus](bench/corpus/README.md)) | **cbor-x example4**: the 7.5 KB clinical-trial document cbor-x's own benchmark uses. **msgpack sample-large**: the 13-record feed @msgpack/msgpack benchmarks with. **Bluesky records**: 100 seeded posts, likes, reposts and follows, shaped like cborg's string-heavy fixtures. **Float mesh**: 1,000 triangles of float vertices, shaped like rust_serialization_benchmark's mesh. **float[] 10000**: plain non-integer numbers |

## Results

### Encode (owned output)

| Workload | pure-cbor | cbor-x | cborg | vs best other |
| --- | ---: | ---: | ---: | ---: |
| uint small † | 25 ns | 109 ns | 80 ns | 3.26× |
| mixed integers | 29 ns | 120 ns | 94 ns | 3.29× |
| timestamp † | 30 ns | 114 ns | 135 ns | 3.84× |
| float64 † | 26 ns | 113 ns | 252 ns | 4.28× |
| boolean/null † | 19 ns | 116 ns | 84 ns | 4.54× |
| ASCII 8 | 55 ns | 137 ns | 106 ns | 1.92× |
| ASCII 32 | 114 ns | 179 ns | 152 ns | 1.34× |
| ASCII 64 | 424 ns | 448 ns | 388 ns | 0.92× |
| Unicode 32 | 391 ns | 442 ns | 456 ns | 1.13× |
| ASCII 4096 | 660 ns | 913 ns | 1314 ns | 1.38× |
| number[] 128 | 556 ns | 899 ns | 1418 ns | 1.61× |
| string[] 128 † | 2388 ns | 2715 ns | 3487 ns | 1.14× |
| mixed[] 128 | 1050 ns | 1201 ns | 1636 ns | 1.14× |
| number[] 10000 | 43.9 µs | 55.2 µs | 121.2 µs | 1.26× |
| Float64Array 1 KiB | 392 ns | 844 ns | – | 2.15× |
| Float64Array 1 MiB | 51.9 µs | 119.6 µs | – | 2.30× |
| object: row | 208 ns | 291 ns | 497 ns | 1.40× |
| object: 100 rows | 18.2 µs | 18.9 µs | 43.8 µs | 1.04× |
| object: nested config | 1453 ns | 1269 ns | 2448 ns | 0.87× |
| corpus: cbor-x example4 | 16.7 µs | 17.3 µs | 50.0 µs | 1.04× |
| corpus: msgpack sample-large | 12.0 µs | 14.8 µs | 21.2 µs | 1.24× |
| corpus: bluesky records 100 | 47.3 µs | 56.5 µs | 66.7 µs | 1.20× |
| corpus: float mesh 1000 | 214.8 µs | 228.7 µs | 2306.8 µs | 1.06× |
| corpus: float[] 10000 | 74.3 µs | 111.5 µs | 1566.1 µs | 1.50× |

### Decode (reused input)

| Workload | pure-cbor | cbor-x | cborg | vs best other |
| --- | ---: | ---: | ---: | ---: |
| uint small † | 10 ns | 22 ns | 73 ns | 2.14× |
| mixed integers | 16 ns | 24 ns | 157 ns | 1.50× |
| timestamp † | 15 ns | 24 ns | 104 ns | 1.59× |
| float64 † | 15 ns | 24 ns | 114 ns | 1.58× |
| boolean/null † | 13 ns | 24 ns | 80 ns | 1.88× |
| ASCII 8 | 24 ns | 35 ns | 137 ns | 1.49× |
| ASCII 32 | 53 ns | 119 ns | 137 ns | 2.23× |
| ASCII 64 | 75 ns | 223 ns | 159 ns | 2.10× |
| Unicode 32 | 247 ns | 245 ns | 329 ns | 0.99× |
| ASCII 4096 | 366 ns | 343 ns | 391 ns | 0.94× |
| number[] 128 | 451 ns | 566 ns | 1761 ns | 1.25× |
| string[] 128 † | 2316 ns | 2187 ns | 5191 ns | 0.94× |
| mixed[] 128 | 951 ns | 904 ns | 1840 ns | 0.95× |
| number[] 10000 | 45.9 µs | 47.3 µs | 145.0 µs | 1.03× |
| Float64Array 1 KiB | 410 ns | 735 ns | – | 1.79× |
| Float64Array 1 MiB | 51.1 µs | 116.6 µs | – | 2.28× |
| object: row | 210 ns | 301 ns | 614 ns | 1.44× |
| object: 100 rows | 21.1 µs | 29.1 µs | 50.5 µs | 1.38× |
| object: nested config | 1259 ns | 1309 ns | 3313 ns | 1.04× |
| corpus: cbor-x example4 | 19.4 µs | 22.4 µs | 40.4 µs | 1.16× |
| corpus: msgpack sample-large | 12.0 µs | 20.5 µs | 27.8 µs | 1.71× |
| corpus: bluesky records 100 | 46.6 µs | 71.2 µs | 86.2 µs | 1.53× |
| corpus: float mesh 1000 | 183.7 µs | 301.3 µs | 845.3 µs | 1.64× |
| corpus: float[] 10000 | 34.0 µs | 51.7 µs | 454.3 µs | 1.52× |

### Decode (fresh input)

| Workload | pure-cbor | cbor-x | cborg | vs best other |
| --- | ---: | ---: | ---: | ---: |
| uint small † | 34 ns | 455 ns | 426 ns | 12.60× |
| mixed integers | 45 ns | 448 ns | 561 ns | 9.92× |
| timestamp † | 40 ns | 501 ns | 478 ns | 12.03× |
| float64 † | 38 ns | 504 ns | 465 ns | 12.15× |
| boolean/null † | 36 ns | 401 ns | 485 ns | 11.10× |
| ASCII 8 | 49 ns | 453 ns | 487 ns | 9.29× |
| ASCII 32 | 81 ns | 447 ns | 418 ns | 5.19× |
| ASCII 64 | 456 ns | 530 ns | 445 ns | 0.98× |
| Unicode 32 | 503 ns | 550 ns | 689 ns | 1.09× |
| ASCII 4096 | 722 ns | 822 ns | 743 ns | 1.03× |
| number[] 128 | 685 ns | 904 ns | 1948 ns | 1.32× |
| string[] 128 † | 2499 ns | 2422 ns | 5487 ns | 0.97× |
| mixed[] 128 | 1131 ns | 1145 ns | 2009 ns | 1.01× |
| number[] 10000 | 46.8 µs | 48.4 µs | 143.8 µs | 1.03× |
| Float64Array 1 KiB | 806 ns | 1140 ns | – | 1.41× |
| object: row | 236 ns | 567 ns | 820 ns | 2.40× |
| object: 100 rows | 21.3 µs | 29.8 µs | 51.5 µs | 1.40× |
| object: nested config | 1475 ns | 1536 ns | 3028 ns | 1.04× |
| corpus: cbor-x example4 | 19.4 µs | 23.2 µs | 41.1 µs | 1.19× |
| corpus: msgpack sample-large | 12.4 µs | 21.0 µs | 28.4 µs | 1.70× |

† A full run is one process per workload. In that run these five workloads hit system noise: for example, float64 decode took 34 ns there, against 15 ns in 0.4.0 and in five repeats. Their rows are the median of three further fresh-process runs.

## Reading the results

**Noise.** A run is one sample. Across repeated runs of the same code, workloads near 1.0× moved by about ±10%:

| Workload | Range seen (vs cbor-x) |
| --- | --- |
| mixed[] 128 encode | 0.85–1.16× |
| object: nested config encode | 0.88–1.09× |
| object: 100 rows encode | 0.94–1.16× |

Treat anything within about ±10% of 1.0 as level. A whole run can also shift when the machine is busy. One run under load showed 10,000-integer decode at 0.74×; run alone it was consistently 1.04×.

**On public data, pure-cbor is fastest in every corpus measurement.**
- Decoding: 1.16–1.71× faster than the next-fastest library.
- Encoding: from level (cbor-x's example document 1.04×, the float mesh 1.06×) to 1.50× faster.
- On cbor-x's own benchmark document, pure-cbor encodes 1.04× and decodes 1.16× faster than cbor-x.

**Where cbor-x is level or ahead, and why:**
- **Arrays of 3–7 character strings, decoded** (0.92–0.97×). The time is dominated by allocating many tiny strings, which every library pays.
- **Long text decoded from a reused buffer** (ASCII 4096, about 0.9×). Both hand long text to `TextDecoder`, but pure-cbor's is **strict** and rejects invalid UTF-8, while cbor-x's silently replaces it. With fresh input they are level.
- **Mixed and tiny-object encoding** (`mixed[]`, nested config): level within noise.
- **Encoding 64-byte strings:** cborg is 8% faster (0.92×). At that size every library pays one off-heap allocation for the output, which dominates.
- **cbor-x records mode** is not in the tables: it's a non-standard wire format both ends must speak. Measured separately, it decodes 100 rows in about 8.6 µs (2.6× faster than pure-cbor) and halves the bytes. It does that by generating object readers with `new Function`. pure-cbor stays standard CBOR and avoids code generation.

**The other CBOR libraries.** A full run against all six (cbor-x, cborg, tiny-cbor, node-cbor, cbor2 and cbor-js; `npm run bench:isolated` with them installed) was made on a loaded machine, so its absolute times aren't published here. On the public corpus, pure-cbor was ahead of or level with every one of them: cbor-x was the fastest of the others on every corpus decode, and cbor-x or cbor2 on corpus encode.

**cborg** is slower across the board here. Part of that is its defaults: it sorts every map's keys and finds the smallest exact float width for every number. Those choices give deterministic, compact output, which pure-cbor and cbor-x don't attempt. For float-heavy data the cost is large: 10–20× slower encoding.

## Streaming

`npm run bench:stream`. Each variant runs in its own process; median of 7 runs. Each run slices fresh chunk buffers inside the timed region for every variant, as a network stream delivers them. Sources are pull-based. Input: 100,000 object rows (6.4 MB) as a CBOR sequence, and one 7.8 MB float mesh as a single item. cbor-x is compared using its Node-stream `DecoderStream`/`EncoderStream` in standard mode; cborg has no streaming API.

### Decode 100,000 rows, 64 KiB chunks

| Variant | Time | MB/s |
| --- | ---: | ---: |
| pure-cbor sequence decoder | 23.5 ms | 270 |
| pure-cbor `decodeStream({ batch: true })` (Web Streams) | 25.3 ms | 251 |
| pure-cbor `decodeSequence` (async iterator) | 33.3 ms | 191 |
| pure-cbor `decodeStream()` (Web Streams, one value per step) | 49.1 ms | 130 |
| cbor-x `DecoderStream` (Node streams) | 37.0 ms | 172 |
| *pure-cbor `decode()` per item, already split, fresh copy each* | *32.4 ms* | *196* |

### Decode 100,000 rows, 1 KiB chunks (6,400 chunk boundaries)

| Variant | Time | MB/s |
| --- | ---: | ---: |
| pure-cbor sequence decoder | 38.1 ms | 167 |
| pure-cbor `decodeStream({ batch: true })` (Web Streams) | 46.9 ms | 136 |
| pure-cbor `decodeSequence` (async iterator) | 48.8 ms | 130 |
| pure-cbor `decodeStream()` (Web Streams, one value per step) | 68.1 ms | 93 |
| cbor-x `DecoderStream` (Node streams) | 91.5 ms | 70 |

### Decode one 7.8 MB item, 16 KiB chunks

| Variant | Time | MB/s |
| --- | ---: | ---: |
| pure-cbor `decodeSequence` (async iterator) | 26.8 ms | 291 |
| pure-cbor `decodeStream()` (Web Streams) | 27.3 ms | 285 |
| pure-cbor sequence decoder | 28.1 ms | 278 |
| pure-cbor `decodeStream({ batch: true })` (Web Streams) | 28.9 ms | 270 |
| cbor-x `DecoderStream` (Node streams) | 40.3 ms | 194 |
| *pure-cbor `decode()` on the whole item* | *22.8 ms* | *343* |

### Encode 100,000 rows

| Variant | Time | MB/s |
| --- | ---: | ---: |
| pure-cbor `encodeStream({ batch: true })`, batches of 1,000, `chunkBytes: 0` | 19.5 ms | 326 |
| pure-cbor `encodeStream({ batch: true })`, batches of 1,000, `chunkBytes: 16384` | 20.4 ms | 311 |
| pure-cbor sequence encoder, `chunkBytes: 16384` | 21.7 ms | 293 |
| pure-cbor sequence encoder, `chunkBytes: 0` | 24.2 ms | 263 |
| pure-cbor `encodeStream()`, `chunkBytes: 16384` (one value per step) | 83.0 ms | 77 |
| pure-cbor `encodeStream()`, `chunkBytes: 0` (one value per step) | 125.8 ms | 51 |
| cbor-x `EncoderStream` (Node streams) | 66.2 ms | 96 |

### Reading the streaming results

- **The incremental core** is faster than cbor-x's streams in every case: 1.6× (64 KiB chunks), 2.4× (1 KiB chunks), 1.4× (a large single item), and 2.7–3.1× when encoding.
- **Batch mode** removes nearly all Web Streams overhead. Values move as one array per chunk, so the ~1 µs per-step cost of Node's Web Streams is paid once per chunk instead of once per value. Batched `decodeStream` is within 8% of the core decoder at 64 KiB chunks, and batched `encodeStream` is 3.4× faster than cbor-x's `EncoderStream`.
- **Web Streams one value per step** cost about 1 µs per value in Node. A do-nothing `TransformStream` passing 100,000 values took about 100 ms by itself. Use batch mode, `decodeSequence`, or the core for high-volume small values.
- **Small chunks are nearly free.** Near the end of each chunk the decoder scans an item's boundary before decoding it, instead of letting the decode throw at the cut. Exceptions had cost about 3.7 µs per boundary, almost all of it stack-trace capture: 1 KiB chunks took 55 ms before this change and 35 ms after.
- **A large item spanning chunks** costs about 20–25% more than decoding it whole (one copy into an assembly buffer plus a header scan), and still beats cbor-x's stream by 1.4×.
- **The per-item `decode()` row** pays a fresh allocation per message, so the sequence decoder working through shared 64 KiB chunks is faster than it.

## Real-world flows: WebAuthn, COSE, CWT, mdoc

`npm run bench:cose`. The vectors are public spec examples (see [test/vectors](test/vectors/README.md)):

- 15 WebAuthn Level 3 attestations;
- 7 COSE_Sign1 messages from the COSE working group's examples;
- the RFC 8392 CWT tokens;
- the ISO 18013-5 Annex D mobile driving licence response.

Before timing, every library must produce the same result as pure-cbor, and pure-cbor is checked against the specs: the right key algorithms, `Sig_structure` bytes identical to the vectors' signed bytes, the claims, the mdoc items and device key. Each flow runs in its own process; median of 5 × 80 ms. The machine was busy for this run (load average about 4.5–7, mostly the Claude desktop app's renderer), so read ±15% into the absolute times.

| Flow | pure-cbor | pure-cbor (borrow) | cbor-x | cborg | tiny-cbor | cbor (node-cbor) | cbor2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| WebAuthn: parse 15 attestations, extract each COSE key | 21.7 µs | 7.6 µs | 7.9 µs | 24.4 µs | 90.8 µs | 153.9 µs | 75.0 µs |
| COSE_Sign1: decode + build `Sig_structure` (7 messages) | 11.7 µs | 5.5 µs | 6.3 µs | 8.2 µs | 39.2 µs | 57.9 µs | 32.5 µs |
| CWT: token + claims (RFC 8392 A.3, A.4) | 1.43 µs | 1.00 µs | 0.95 µs | 2.08 µs | 8.5 µs | 13.4 µs | 7.2 µs |
| mdoc: device response + items + MSO | 8.5 µs | 6.0 µs | 6.5 µs | 14.2 µs | 69.0 µs | 59.9 µs | 43.9 µs |
| COSE_Key: encode | 692 ns | 686 ns | 474 ns | 862 ns | 6.3 µs | 3.4 µs | 9.7 µs |

How pure-cbor compares (fastest other library divided by pure-cbor; above 1 means pure-cbor is faster):

| Flow | pure-cbor (default) | pure-cbor (borrow) |
| --- | ---: | ---: |
| WebAuthn | 0.37× | 1.04× |
| COSE_Sign1 | 0.54× | 1.15× |
| CWT | 0.66× | 0.95× |
| mdoc | 0.76× | 1.07× |
| COSE_Key encode | 0.69× | 0.69× |

The table above was measured on 0.5.0. In 0.6.0 the default mode copies byte strings into one per-decode arena, and `Map` and byte strings encode through inline fast paths. Measured in one process against 0.5.0 (bursts alternated, so machine load affects both builds equally):

| | 0.5.0 | 0.6.0 |
| --- | ---: | ---: |
| WebAuthn, 15 attestations, decode (default `copy`) | 35–47 µs | **18–21 µs** |
| — with `copy-separate` (0.5.0's behaviour) | — | 35–47 µs |
| — with `borrow` | 8–11 µs | 8–11 µs |
| COSE_Key encode (cbor-x: 1,114 ns) | 1,241 ns | **1,029 ns** |
| `Sig_structure` encode (cbor-x: 1,151 ns) | 628 ns | **430 ns** |

### Reading the flow results

- **Byte-string copies dominate these formats.** Certificates, signatures and keys make COSE and WebAuthn messages mostly byte strings, and in V8 every separate copy over 64 bytes is a ~0.5 µs allocation. Since 0.6.0 the default copy puts all of a message's large byte strings into one arena, so a message costs about one allocation. That halves the default mode's time on these flows.
- **Borrow mode** (views into the input, as cbor-x does by default) is fastest and level with or ahead of cbor-x. It's safe while the input stays unchanged, which is the normal case when verifying a message.
- **The libraries WebAuthn and COSE packages actually use** (tiny-cbor, node-cbor, cbor2) are **5–20× slower** than pure-cbor in every flow.
- **Encoding a COSE_Key:** cbor-x was 1.4× faster than pure-cbor 0.5.0. With 0.6.0's `Map` and byte-string fast paths, pure-cbor is now slightly ahead.
- **Byte types differ across libraries:**
  - In Node, cbor-x and node-cbor write a plain `Uint8Array` as an RFC 8746 typed array (tag 64), not a byte string. Worse, when cbor-x decodes from a plain `Uint8Array`, the byte strings it returns re-encode that way. A `Sig_structure` built from them silently comes out different, so signature checks would fail. With `Buffer` inputs both libraries behave.
  - cbor2 writes a Node `Buffer` as a `{ type, data }` map.
  - pure-cbor treats `Uint8Array` and `Buffer` identically. The benchmark gives each library its preferred byte type.

## Where the wins come from

- **Fresh inputs and small owned outputs: no DataView.** In V8, building a DataView on a small fresh buffer moves it off-heap (~900 ns per message). That's most of the time cbor-x and cborg spend on small fresh messages.
- **Objects:**
  - allocation-free `for…in` enumeration;
  - a single-pass map writer that patches the preferred header at the end;
  - a decoded-key cache;
  - a count-based duplicate check;
  - small-integer values decoded inline.
- **Float-heavy data:** one shared DataView per decode for float arrays, and unrolled byte copies when encoding.
- **Typed arrays:** one bulk copy per array, with aligned borrowing available on decode.

## Wire size

pure-cbor writes preferred (smallest) map headers. cbor-x's standard encoder always writes a 3-byte map header unless `variableMapSize: true`. One object row is 57 vs 59 bytes; 100 rows are 5,868 vs 6,068 bytes. cborg writes smaller floats, so it produces the smallest output for float-heavy data.

## Correctness status

106 tests pass with the comparison libraries installed:

- **Real-world vectors:**
  - all 63 COSE working-group examples decode and re-encode byte for byte, and 31 rebuilt `Sig_structure`/`MAC_structure`s match the signed bytes exactly;
  - the RFC 8392 CWT claims decode as expected;
  - all 15 WebAuthn Level 3 attestations parse, with correct COSE keys (ES256/384/512, RS256, Ed25519, Ed448);
  - the ISO 18013-5 Annex D flow decodes, including embedded CBOR, and re-encodes byte for byte when date tags are kept as written.
- **RFC 8949 Appendix A:** every example decodes; every example JS can represent exactly encodes back to the same bytes.
- **Deterministic encoding:** RFC 8949 §4.2.1 key order, and byte-for-byte equality with cborg's canonical output on the public corpus.
- **Round trips:** 2,000 seeded random nested trees through owned, prepared and slab encoding; 20,000 seeded scalar round trips; the public and generated corpus.
- **Interoperability:**
  - 2,000 random trees checked both ways against cbor-x;
  - the corpus checked both ways against cbor-x and cborg, including cborg's half-precision floats and sorted keys.
- **Text:** 20,000 short-text cases checked against `TextDecoder` in strict and replace modes.
- **Streaming:**
  - every split point of a mixed sequence;
  - every chunk size from 1 to 64 bytes, and 200 random chunkings;
  - a linear-time check (4× the data takes about 4× the time);
  - malformed input giving the same error code under every chunking;
  - limits, absolute offsets, cancellation, lazy pulling, both batch modes;
  - interop with cbor-x's `EncoderStream`/`DecoderStream` in both directions.
- **Hostile input:**
  - 30,000 random and container-heavy malformed inputs, which may only produce values or `CborError`s;
  - depth bombs and nested allocation bombs;
  - prototype pollution in both directions.

- **Runtimes:** CI runs the whole suite on Node 22, 24 and latest and on Deno, and the portable conformance suite (`test/portable/suite.mjs`) on Bun, workerd (through Miniflare), and Chromium, Firefox and WebKit, both on the page and in a module web worker.

The benchmarks were taken on Node 22 only; performance in other runtimes is not yet measured.
