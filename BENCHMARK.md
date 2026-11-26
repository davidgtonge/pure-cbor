# pure-cbor vs cbor-x and cborg

Versions before 1.0.0 were named cbor-fp.

Node v22.19.0, macOS arm64, pure-cbor 1.0.2, measured on 25 November 2026 with the machine otherwise idle (load average 1.6–2.5).

**Libraries:**
- **cbor-x**: pure JS (native string extraction disabled), in standard CBOR mode (`useRecords: false`).
- **cborg**: default options. It sorts map keys and writes floats at their smallest exact width, which is extra work pure-cbor and cbor-x don't do.
- **tiny-cbor, node-cbor (`cbor`), cbor2, cbor-js**: default options. "–" marks a workload a library can't round-trip exactly.
- **msgpackr, @msgpack/msgpack**: MessagePack, a different format, for reference only.

**Method:**
- Each workload runs in its **own Node process**. Workloads sharing a process skewed each other's V8 type feedback by up to 2×.
- Median of 5 × 80 ms rounds.
- Before timing, every workload is checked to round-trip exactly through pure-cbor and to read back identically in cbor-x and cborg.
- Each library decodes its own encoding of the same value.

**Columns:**
- **Encode (owned):** an independently owned `Uint8Array`; for cbor-x, `Uint8Array.from(encoder.encode(v))`, since its plain `encode()` returns a view into a reused buffer.
- **Decode (reused):** the same input buffer every call.
- **Decode (fresh):** a new copy every call, like a just-received message (only timed for inputs up to 64 KiB).
- **vs best CBOR:** the fastest other CBOR library's time divided by pure-cbor's; above 1 means pure-cbor is faster. **vs best overall** includes the MessagePack libraries.

Reproduce:

```sh
npm install --no-save --package-lock=false cbor-x cborg @levischuck/tiny-cbor cbor cbor2 cbor-js msgpackr @msgpack/msgpack
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

One full run. The public-corpus rows were run twice more: the medians of the three runs are in the [README](README.md#speed), and the spread is under ±0.05× except where the notes below say otherwise.

### Encode (owned output)

| Workload | pure-cbor | cbor-x | cborg | tiny-cbor | cbor (node-cbor) | cbor2 | cbor-js | msgpackr | @msgpack/msgpack | vs best CBOR | vs best overall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| uint small | 19 ns | 107 ns | 84 ns | 451 ns | 2734 ns | 1615 ns | 1044 ns | 116 ns | 493 ns | 4.32× | 4.32× |
| mixed integers | 27 ns | 115 ns | 95 ns | 458 ns | 2703 ns | 1355 ns | 1220 ns | 120 ns | 476 ns | 3.57× | 3.57× |
| timestamp | 27 ns | 111 ns | 140 ns | 466 ns | 2569 ns | 1324 ns | 1188 ns | 116 ns | 447 ns | 4.11× | 4.11× |
| float64 | 24 ns | 111 ns | 260 ns | 491 ns | 2262 ns | 1353 ns | 1190 ns | 118 ns | 492 ns | 4.68× | 4.68× |
| boolean/null | 17 ns | 113 ns | 85 ns | 32 ns | 2296 ns | 1377 ns | 1212 ns | 118 ns | 472 ns | 1.84× | 1.84× |
| ASCII 8 | 46 ns | 123 ns | 105 ns | 1056 ns | 2267 ns | 1770 ns | 975 ns | 130 ns | 479 ns | 2.31× | 2.31× |
| ASCII 32 | 102 ns | 177 ns | 161 ns | 1007 ns | 2375 ns | 2844 ns | 1045 ns | 187 ns | 563 ns | 1.57× | 1.57× |
| ASCII 64 | 518 ns | 503 ns | 480 ns | 1533 ns | 2601 ns | 3254 ns | 1198 ns | 482 ns | 547 ns | 0.93× | 0.93× |
| Unicode 32 | 538 ns | 489 ns | 498 ns | 1612 ns | 2652 ns | 2192 ns | 1197 ns | 575 ns | 585 ns | 0.91× | 0.91× |
| ASCII 4096 | 650 ns | 771 ns | 1270 ns | 1592 ns | 4321 ns | 3291 ns | 19.5 µs | 876 ns | 7698 ns | 1.19× | 1.19× |
| number[] 128 | 605 ns | 941 ns | 1391 ns | 62.5 µs | 20.7 µs | 3053 ns | 3176 ns | 900 ns | 996 ns | 1.55× | 1.49× |
| string[] 128 | 2287 ns | 2741 ns | 3433 ns | 134.8 µs | 24.8 µs | 69.6 µs | 6992 ns | 2469 ns | 3583 ns | 1.20× | 1.08× |
| mixed[] 128 | 1403 ns | 1218 ns | 1652 ns | 51.2 µs | 17.4 µs | 16.3 µs | 3590 ns | 1156 ns | 1640 ns | 0.87× | 0.82× |
| number[] 10000 | 43.4 µs | 55.2 µs | 118.6 µs | 4756.6 µs | 1632.7 µs | 120.4 µs | 231.5 µs | 55.0 µs | 87.0 µs | 1.27× | 1.27× |
| Float64Array 1 KiB | 439 ns | 848 ns | – | – | 2998 ns | 1786 ns | – | – | – | 1.93× | 1.93× |
| Float64Array 1 MiB | 48.8 µs | 109.9 µs | – | – | 109.6 µs | 48.5 µs | – | – | – | 1.00× | 1.00× |
| object: row | 177 ns | 288 ns | 500 ns | 9808 ns | 4132 ns | 13.6 µs | 1226 ns | 282 ns | 629 ns | 1.63× | 1.59× |
| object: 100 rows | 18.3 µs | 17.9 µs | 42.3 µs | 765.4 µs | 257.9 µs | 1211.3 µs | 51.6 µs | 17.2 µs | 28.3 µs | 0.98× | 0.94× |
| object: nested config | 1171 ns | 1314 ns | 2249 ns | 81.8 µs | 18.6 µs | 83.5 µs | 3660 ns | 1271 ns | 1957 ns | 1.12× | 1.08× |
| corpus: cbor-x example4 | 14.7 µs | 20.6 µs | 50.4 µs | 638.2 µs | 133.9 µs | 656.3 µs | 41.1 µs | 15.2 µs | 23.5 µs | 1.40× | 1.04× |
| corpus: msgpack sample-large | 12.0 µs | 14.6 µs | 21.3 µs | 232.7 µs | 82.9 µs | 387.7 µs | 60.1 µs | 11.8 µs | 23.4 µs | 1.22× | 0.98× |
| corpus: bluesky records 100 | 46.0 µs | 55.6 µs | 65.2 µs | 1237.7 µs | 317.8 µs | 1310.5 µs | 146.0 µs | 45.7 µs | 80.2 µs | 1.21× | 0.99× |
| corpus: float mesh 1000 | 240.8 µs | 221.1 µs | 2282.4 µs | 7846.0 µs | – | 3663.1 µs | 507.3 µs | 162.5 µs | 280.3 µs | 0.92× | 0.68× |
| corpus: float[] 10000 | 69.7 µs | 108.0 µs | 1505.8 µs | 3495.3 µs | – | 115.7 µs | 246.9 µs | 74.7 µs | 122.0 µs | 1.55× | 1.07× |

### Decode (reused input)

| Workload | pure-cbor | cbor-x | cborg | tiny-cbor | cbor (node-cbor) | cbor2 | cbor-js | msgpackr | @msgpack/msgpack | vs best CBOR | vs best overall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| uint small | 10 ns | 21 ns | 79 ns | 50 ns | 1701 ns | 696 ns | 101 ns | 35 ns | 85 ns | 2.05× | 2.05× |
| mixed integers | 13 ns | 23 ns | 91 ns | 79 ns | 1423 ns | 631 ns | 99 ns | 36 ns | 86 ns | 1.75× | 1.75× |
| timestamp | 14 ns | 23 ns | 111 ns | 101 ns | 1389 ns | 643 ns | 102 ns | 37 ns | 84 ns | 1.64× | 1.64× |
| float64 | 14 ns | 23 ns | 117 ns | 50 ns | 1657 ns | 636 ns | 101 ns | 37 ns | 85 ns | 1.57× | 1.57× |
| boolean/null | 12 ns | 23 ns | 84 ns | 52 ns | 1294 ns | 642 ns | 96 ns | 35 ns | 91 ns | 1.89× | 1.89× |
| ASCII 8 | 20 ns | 33 ns | 118 ns | 600 ns | 1659 ns | 712 ns | 148 ns | 45 ns | 118 ns | 1.66× | 1.66× |
| ASCII 32 | 54 ns | 117 ns | 145 ns | 597 ns | 1849 ns | 743 ns | 234 ns | 137 ns | 188 ns | 2.18× | 2.18× |
| ASCII 64 | 72 ns | 210 ns | 144 ns | 610 ns | 1799 ns | 738 ns | 360 ns | 243 ns | 294 ns | 2.01× | 2.01× |
| Unicode 32 | 309 ns | 247 ns | 296 ns | 668 ns | 1995 ns | 891 ns | 314 ns | 265 ns | 210 ns | 0.80× | 0.68× |
| ASCII 4096 | 357 ns | 358 ns | 390 ns | 844 ns | 2235 ns | 1040 ns | 18.5 µs | 408 ns | 438 ns | 1.00× | 1.00× |
| number[] 128 | 443 ns | 562 ns | 1748 ns | 4480 ns | 21.9 µs | 10.2 µs | 1161 ns | 608 ns | 604 ns | 1.27× | 1.27× |
| string[] 128 | 2282 ns | 2158 ns | 5144 ns | 75.9 µs | 30.1 µs | 20.4 µs | 4540 ns | 1936 ns | 3902 ns | 0.95× | 0.85× |
| mixed[] 128 | 937 ns | 880 ns | 1857 ns | 18.2 µs | 20.2 µs | 14.2 µs | 1700 ns | 887 ns | 1401 ns | 0.94× | 0.94× |
| number[] 10000 | 45.4 µs | 46.0 µs | 142.2 µs | 381.0 µs | 1754.0 µs | 723.1 µs | 82.6 µs | 37.1 µs | 41.3 µs | 1.01× | 0.82× |
| Float64Array 1 KiB | 426 ns | 676 ns | – | – | 3141 ns | 1161 ns | – | – | – | 1.59× | 1.59× |
| Float64Array 1 MiB | 46.8 µs | 111.2 µs | – | – | 54.9 µs | 150.2 µs | – | – | – | 1.17× | 1.17× |
| object: row | 205 ns | 290 ns | 585 ns | 5209 ns | 4656 ns | 3308 ns | 510 ns | 189 ns | 351 ns | 1.42× | 0.92× |
| object: 100 rows | 20.9 µs | 28.6 µs | 51.1 µs | 538.7 µs | 334.8 µs | 286.1 µs | 41.5 µs | 26.7 µs | 24.2 µs | 1.37× | 1.16× |
| object: nested config | 1235 ns | 1306 ns | 2071 ns | 40.4 µs | 25.7 µs | 21.0 µs | 2262 ns | 1139 ns | 1964 ns | 1.06× | 0.92× |
| corpus: cbor-x example4 | 18.8 µs | 22.7 µs | 39.7 µs | 300.6 µs | 190.7 µs | 180.2 µs | 35.8 µs | 20.5 µs | 23.2 µs | 1.20× | 1.09× |
| corpus: msgpack sample-large | 12.0 µs | 20.6 µs | 28.1 µs | 204.0 µs | 110.8 µs | 89.7 µs | 40.8 µs | 19.3 µs | 20.0 µs | 1.72× | 1.61× |
| corpus: bluesky records 100 | 45.9 µs | 71.2 µs | 85.5 µs | 634.0 µs | 413.3 µs | 320.7 µs | 119.8 µs | 67.3 µs | 85.4 µs | 1.55× | 1.47× |
| corpus: float mesh 1000 | 184.0 µs | 299.8 µs | 844.0 µs | 1510.4 µs | – | 4174.2 µs | 391.4 µs | 290.3 µs | 177.2 µs | 1.63× | 0.96× |
| corpus: float[] 10000 | 33.5 µs | 51.7 µs | 438.9 µs | 143.5 µs | – | 1045.1 µs | 82.0 µs | 48.6 µs | 53.3 µs | 1.54× | 1.45× |

### Decode (fresh input)

| Workload | pure-cbor | cbor-x | cborg | tiny-cbor | cbor (node-cbor) | cbor2 | cbor-js | msgpackr | @msgpack/msgpack | vs best CBOR | vs best overall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| uint small | 32 ns | 387 ns | 455 ns | 425 ns | 1895 ns | 896 ns | 641 ns | 430 ns | 459 ns | 11.94× | 11.94× |
| mixed integers | 38 ns | 427 ns | 450 ns | 437 ns | 1648 ns | 838 ns | 577 ns | 504 ns | 502 ns | 11.36× | 11.36× |
| timestamp | 37 ns | 471 ns | 465 ns | 441 ns | 1567 ns | 854 ns | 622 ns | 475 ns | 515 ns | 11.89× | 11.89× |
| float64 | 37 ns | 476 ns | 469 ns | 441 ns | 2034 ns | 834 ns | 591 ns | 470 ns | 503 ns | 11.84× | 11.84× |
| boolean/null | 35 ns | 505 ns | 475 ns | 518 ns | 1534 ns | 845 ns | 615 ns | 489 ns | 495 ns | 13.42× | 13.42× |
| ASCII 8 | 45 ns | 521 ns | 493 ns | 1190 ns | 2084 ns | 917 ns | 591 ns | 503 ns | 464 ns | 10.93× | 10.28× |
| ASCII 32 | 81 ns | 457 ns | 424 ns | 1057 ns | 2183 ns | 939 ns | 652 ns | 463 ns | 499 ns | 5.23× | 5.23× |
| ASCII 64 | 475 ns | 523 ns | 456 ns | 1107 ns | 2175 ns | 929 ns | 784 ns | 579 ns | 578 ns | 0.96× | 0.96× |
| Unicode 32 | 483 ns | 545 ns | 537 ns | 1110 ns | 2338 ns | 1091 ns | 736 ns | 611 ns | 531 ns | 1.11× | 1.10× |
| ASCII 4096 | 868 ns | 745 ns | 742 ns | 1463 ns | 2622 ns | 1497 ns | 19.9 µs | 901 ns | 909 ns | 0.85× | 0.85× |
| number[] 128 | 690 ns | 884 ns | 1936 ns | 4651 ns | 22.2 µs | 10.4 µs | 1458 ns | 867 ns | 820 ns | 1.28× | 1.19× |
| string[] 128 | 2463 ns | 2383 ns | 5365 ns | 74.5 µs | 30.1 µs | 20.0 µs | 4863 ns | 2192 ns | 4130 ns | 0.97× | 0.89× |
| mixed[] 128 | 1133 ns | 1115 ns | 2029 ns | 20.0 µs | 20.5 µs | 14.4 µs | 1974 ns | 1118 ns | 1545 ns | 0.98× | 0.98× |
| number[] 10000 | 46.2 µs | 48.4 µs | 141.7 µs | 382.8 µs | 1758.5 µs | 725.7 µs | 83.8 µs | 39.2 µs | 42.2 µs | 1.05× | 0.85× |
| Float64Array 1 KiB | 877 ns | 1308 ns | – | – | 3058 ns | 1503 ns | – | – | – | 1.49× | 1.49× |
| object: row | 232 ns | 569 ns | 806 ns | 5418 ns | 5440 ns | 3519 ns | 846 ns | 528 ns | 591 ns | 2.45× | 2.27× |
| object: 100 rows | 21.3 µs | 30.2 µs | 51.4 µs | 550.1 µs | 337.3 µs | 285.3 µs | 44.1 µs | 26.9 µs | 24.5 µs | 1.42× | 1.15× |
| object: nested config | 1422 ns | 1541 ns | 2222 ns | 41.6 µs | 25.9 µs | 21.2 µs | 2522 ns | 1381 ns | 2023 ns | 1.08× | 0.97× |
| corpus: cbor-x example4 | 19.4 µs | 23.2 µs | 39.9 µs | 295.7 µs | 192.7 µs | 181.6 µs | 36.5 µs | 21.1 µs | 23.6 µs | 1.19× | 1.08× |
| corpus: msgpack sample-large | 12.3 µs | 20.9 µs | 28.3 µs | 198.9 µs | 110.9 µs | 90.0 µs | 41.6 µs | 19.7 µs | 20.4 µs | 1.70× | 1.60× |

## Reading the results

**Noise.** A run is one sample. Across repeated runs of the same code, workloads near 1.0× moved by about ±10%:

| Workload | Range seen (vs cbor-x) |
| --- | --- |
| mixed[] 128 encode | 0.85–1.16× |
| object: nested config encode | 0.88–1.09× |
| object: 100 rows encode | 0.94–1.16× |

Treat anything within about ±10% of 1.0 as level. A whole run can also shift when the machine is busy. One run under load showed 10,000-integer decode at 0.74×; run alone it was consistently 1.04×.

**On public data, pure-cbor decodes fastest in every corpus measurement.**
- Decoding: 1.21–1.72× faster than the next-fastest CBOR library (medians of three runs).
- Encoding: from 0.93× (the float mesh, where cbor-x is slightly ahead: 0.92–1.01× over four runs) to 1.55× faster.
- On cbor-x's own benchmark document, pure-cbor encodes 1.15× and decodes 1.21× faster than cbor-x.

**Where pure-cbor is level or behind, and why:**
- **Arrays of short strings and mixed arrays** (`string[] 128`, `mixed[] 128`): 0.87–0.98×. The time goes on allocating many tiny strings and values, which every library pays.
- **Long text from a fresh buffer** (ASCII 4096, 0.85×). Both hand long text to `TextDecoder`, but pure-cbor's is **strict** and rejects invalid UTF-8, while cbor-x's silently replaces it. From a reused buffer they are level (1.00×).
- **Encoding 64-byte and Unicode strings**: 0.91–0.93× in the full run, 1.04–1.37× for Unicode in three reruns: level within noise. At that size every library pays one off-heap allocation for the output.
- **The float mesh, encoded**: cbor-x is about 7% faster.
- **cbor-x records mode** is not in the tables: it's a non-standard wire format both ends must speak. Measured separately, it decodes 100 rows in about 8.6 µs (2.4× faster than pure-cbor) and halves the bytes. It does that by generating object readers with `new Function`. pure-cbor stays standard CBOR and generates no code.

**The other CBOR libraries.** tiny-cbor, node-cbor, cbor2 and cbor-js are slower than pure-cbor in every workload but two (cbor2 encodes a 1 MiB `Float64Array` level, 0.99×; cbor-js decodes Unicode 32 level, 1.02×). Across all workloads the median is 13× slower.

**MessagePack.** msgpackr is faster than pure-cbor on a few workloads, most of all the float mesh (1.48× when encoding) and large integer arrays (1.2× when decoding). It writes a different format, so it's here for reference only.

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

## cbor-x with its native addon

The tables above run cbor-x as pure JavaScript. On Node, npm also installs its optional `cbor-extract` addon (a prebuilt binary), and cbor-x uses it unless `CBOR_NATIVE_ACCELERATION_DISABLED=true`. Browsers, workers and Deno never get it.

**What it does.** It only affects decoding text. On the first text string, one native call scans ahead through the CBOR and creates up to 256 upcoming strings. Runs of nearby ASCII strings become a single string (`napi_create_string_latin1`), and each CBOR string is handed out as a slice of it. Encoding is unaffected.

**Measured.** Decoding one value per operation, each library in its own process, median of 7 rounds; the table is the median of three such runs. pure-cbor from `main` after 1.0.2 (with text windows, below), Node 22.19, macOS arm64; cbor-x 1.6.9, cbor-extract 2.2.3. "pure-cbor vs native" is cbor-x's native time divided by pure-cbor's; above 1 means pure-cbor is faster.

| Decode | pure-cbor | cbor-x, pure JS | cbor-x, native addon | pure-cbor vs native |
| --- | ---: | ---: | ---: | ---: |
| 100 Bluesky-style records | 36.3 µs | 71.0 µs | 39.9 µs | **1.10×** |
| msgpack sample-large | 10.6 µs | 21.4 µs | 12.2 µs | **1.15×** |
| cbor-x's benchmark document | 19.1 µs | 23.1 µs | 20.2 µs | **1.05×** |
| 128 short strings | 2.62 µs | 2.17 µs | 1.84 µs | 0.72× |
| 2 KB of text | 0.25 µs | 0.24 µs | 0.22 µs | 0.88× |
| 100 object rows | 21.4 µs | 30.6 µs | 29.7 µs | **1.39×** |

The addon makes cbor-x 1.1–2× faster on text. pure-cbor is ahead of it on the three text-heavy datasets and on objects with short repeated keys (its key cache). The addon still wins on arrays of very short strings (1.4×) and on one long string (1.14×), where C++ creates each string with no per-string JavaScript work.

**Doing the same in JavaScript.** Turning bytes into a string costs about 130 ns per `TextDecoder` call, whatever the length, so for strings over 32 bytes the call is most of the cost. Three earlier pure-JavaScript versions of the batch were built and measured, and all were slower on real data (medians of three runs, measured on battery power, so slower than the table above):

| Decode, µs | Before | Packed by a JS loop | Packed with `set()` | One span, no copy | cbor-x native |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 Bluesky-style records | 85.7 | 99.2 | 97.9 | 120.3 | 75.3 |
| msgpack sample-large | 24.0 | 28.0 | 40.0 | 35.4 | 22.8 |
| cbor-x's benchmark document | 35.6 | 43.2 | 42.9 | 54.2 | 37.7 |

They taught three things:
- **Every JavaScript route from bytes to string costs per string:** a `TextDecoder` call, a typed-array view to copy from, or a loop over the bytes. Only one call covering many strings saves anything.
- **`TextDecoder('latin1')` is really Windows-1252.** It maps bytes 0x80–0x9F, which CBOR uses for array headers and length bytes, to characters above U+00FF. So a span containing one becomes a two-byte string, and so does every slice of it. It is also slow: 1.2–1.8 ns per byte on Node 22–26, against 0.1 ns for UTF-8.
- **Extra work in the array loop's text path costs about 15%** on short-string arrays, by spending V8's inlining budget.

**What works.** When a container holds an ASCII string of 33–255 bytes, the decoder copies up to 4 KiB of the input from there into a reused scratch buffer, masks every byte to 7 bits, and decodes it with one UTF-8 `TextDecoder` call. Masking makes the window pure ASCII, so it decodes one byte to one character at the fastest rate; only bytes outside strings (headers, numbers) change, and those are never read as text. Every ASCII string of 16–255 bytes inside the window is then a slice of it. Strings up to 32 bytes keep the JavaScript fast path until a window exists, and the hot loops are untouched. Against the decoder before this, in three alternating runs: Bluesky records 1.24×, sample-large 1.17×, everything else within noise. The trade-off, as with the byte-string arena: a decoded string that is a slice keeps its window (at most 4 KiB) alive while it is referenced.

## Real-world flows: WebAuthn, COSE, CWT, mdoc

`npm run bench:cose`. The vectors are public spec examples (see [test/vectors](test/vectors/README.md)):

- 15 WebAuthn Level 3 attestations;
- 7 COSE_Sign1 messages from the COSE working group's examples;
- the RFC 8392 CWT tokens;
- the ISO 18013-5 Annex D mobile driving licence response.

Before timing, every library must produce the same result as pure-cbor, and pure-cbor is checked against the specs: the right key algorithms, `Sig_structure` bytes identical to the vectors' signed bytes, the claims, the mdoc items and device key. Each flow runs in its own process; median of 5 × 80 ms. The machine was busy for this run (load average about 4.5–7, mostly the Claude desktop app's renderer), so read ±15% into the absolute times.

| Flow | pure-cbor | pure-cbor (borrow) | cbor-x | cborg | tiny-cbor | cbor (node-cbor) | cbor2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| WebAuthn: parse 15 attestations | 12.9 µs | 7878 ns | 7494 ns | 23.9 µs | 98.4 µs | 126.7 µs | 66.1 µs |
| COSE_Sign1: decode + Sig_structure (7 messages) | 4968 ns | 4192 ns | 5747 ns | 8120 ns | 39.1 µs | 57.6 µs | 31.2 µs |
| CWT: token + claims (RFC 8392 A.3, A.4) | 1522 ns | 1011 ns | 951 ns | 2132 ns | 8703 ns | 11.7 µs | 7112 ns |
| mdoc: device response + items + MSO | 7097 ns | 6194 ns | 6258 ns | 13.8 µs | 69.8 µs | 59.9 µs | 44.0 µs |
| COSE_Key: encode | 678 ns | 635 ns | 471 ns | 868 ns | 6125 ns | 3304 ns | 9166 ns |

How pure-cbor compares (fastest other library divided by pure-cbor; above 1 means pure-cbor is faster):

| Flow | pure-cbor (default) | pure-cbor (borrow) |
| --- | ---: | ---: |
| WebAuthn | 0.58× | 0.95× |
| COSE_Sign1 | 1.16× | 1.37× |
| CWT | 0.62× | 0.94× |
| mdoc | 0.88× | 1.01× |
| COSE_Key encode | 0.69× | 0.74× |

One run, measured on 1.0.2. History: in 0.6.0 the default mode began copying byte strings into one per-decode arena, and `Map` and byte strings gained inline encode paths. Measured in one process against 0.5.0 (bursts alternated, so machine load affects both builds equally):

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
- **The libraries WebAuthn and COSE packages actually use** (tiny-cbor, node-cbor, cbor2) are **5–14× slower** than pure-cbor in every flow.
- **Encoding a COSE_Key:** cbor-x is about 1.4× faster (471 vs 678 ns), each library in its own process. The 0.6.0 comparison above, run in one shared process, had pure-cbor slightly ahead; the separate-process numbers are the ones to trust.
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

114 tests pass with the comparison libraries installed:

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
