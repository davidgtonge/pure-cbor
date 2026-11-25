# pure-cbor

CBOR for JavaScript and TypeScript, with two promises:

1. **Clean, functional code.** Pure functions over explicit state, in the spirit of OCaml: no classes (apart from the error type), no state kept between calls apart from two documented caches (decoded map keys, and one write function per encode-option set), immutable tagged variants, and one named set of wire constants. About 2,800 lines of strict TypeScript, with no runtime dependencies, no Node APIs and no generated code (CSP-safe).
2. **The fastest standard CBOR library for JavaScript.** Pure JS, no native addon. On public benchmark data it decodes 1.16–1.71× faster than cbor-x, the next fastest of the six other CBOR libraries measured, and encodes level with it to 1.50× faster (cbor-x also measured as pure JS, without its optional native addon). Small messages decoded from a fresh buffer are 5–12× faster. It isn't ahead everywhere: some small mixed arrays and objects are level, and on COSE and WebAuthn messages it matches cbor-x only with `binaryOwnership: 'borrow'`, since cbor-x returns views into the input by default while pure-cbor copies. Details in [BENCHMARK.md](BENCHMARK.md#reading-the-results).

It covers the whole RFC 8949 data model (tags, bignums, dates, `Map`, simple values, typed arrays), deterministic encoding, CBOR sequences over Web Streams, and COSE, CWT, WebAuthn and mdoc messages, checked against their published test vectors. Standard CBOR only: no private wire format.

**[Read the guided tour of the code →](https://davidgtonge.github.io/pure-cbor/)** Its principles, and how a value flows through encode and decode, with diagrams and excerpts from the source.

## Why pure-cbor

- **Fast without tricks.** It is the fastest standard CBOR library measured, in pure JavaScript, with no native addon and no generated code. It runs unchanged where those aren't allowed: browsers with a strict CSP, web workers and edge runtimes. The same suite passes on Node, Deno, Bun, workerd, Chromium, Firefox and WebKit.
- **Built for messages you have to trust.**
  - **Hostile input:** limits are checked before anything is allocated, and every failure is a typed `CborError` with a byte offset, never a stack overflow or an out-of-bounds read. Invalid UTF-8 and duplicate map keys are rejected by default. For `Map` keys, only equal primitives are detected: see [decode options](#decode-options-and-limits).
  - **Signed data:** deterministic encoding, plus re-encoding signed data byte for byte.
  - **Published vectors:** COSE, CWT, WebAuthn and mdoc messages are checked against them.
- **Small enough to read.** About 2,200 lines of code, organised as one job per file, with a [guided tour](https://davidgtonge.github.io/pure-cbor/) that follows a value through every step.
- **Nothing else to trust.**
  - No runtime dependencies, not even optional ones.
  - Releases are built in GitHub Actions and published with npm provenance.
  - CI actions are pinned to commit SHAs.

### Compared with other CBOR libraries

| Library | Version | Runtime dependencies | Lines of code | Minified + gzip |
|---|---|---|---:|---:|
| **pure-cbor** | 1.0.1 | none | 2,191 | 11.4 KB |
| cbor-x | 1.6.9 | optional `cbor-extract`, a native addon: 4 packages including a prebuilt binary | 2,973 | 15.0 KB |
| cborg | 7.0.0 | none | 1,876 | 8.9 KB |
| cbor2 | 2.4.2 | 1 (`@cto.af/wtf8`) | 3,073 | 15.4 KB |
| cbor (node-cbor) | 10.0.12 | 1 (`nofilter`), plus Node's `stream` and `Buffer` | 2,941 | 13.0 KB |
| @levischuck/tiny-cbor | 0.3.6 | none | 438 | 2.1 KB |
| cbor-js | 0.1.0 | none | 378 | 2.1 KB |

**How this was measured:**

- Each library's whole public API (`export * from '…'`) was bundled with esbuild 0.25 as ESM, including its JavaScript dependencies. Node's built-in modules and cbor-x's native addon were left out.
- "Lines of code" counts the non-blank, non-comment lines of the unminified bundle. Bundling reformats every library the same way, so the counts are comparable.
- For pure-cbor, the bundle count matches its own TypeScript source: 2,190 lines of code, or 2,844 with comments.
- Measured in November 2026.

**When another library fits better:**

- **Smallest bundle:** cborg is 15–20% smaller. On the public corpus it is 1.4–21× slower, partly because by default it does extra work: it sorts map keys and writes the smallest float. See [BENCHMARK.md](BENCHMARK.md).
- **Smaller still:** tiny-cbor and cbor-js are a fifth of the size, and do less.
  - tiny-cbor throws on bigints beyond 64 bits, `Date`s, typed arrays, half-precision floats and indefinite lengths.
  - cbor-js turns bigints, `Date`s and `Map`s into `{}` and drops tags.
- **Both ends under your control:** cbor-x's records mode decodes repeated object shapes about 2.6× faster, using a non-standard wire format and `new Function`.

## Install

```sh
npm install pure-cbor
```

Plain ESM with TypeScript declarations, needing only ES2023 and `TextEncoder`/`TextDecoder`. Tested on Node 22, 24 and 26, Deno, Bun, workerd, and Chromium, Firefox and WebKit, both on the page and in web workers.

```ts
import { encode, decode } from 'pure-cbor';

const bytes = encode({ id: 7, name: 'Ada', tags: ['x', 'y'], active: true, manager: null });
console.log(decode(bytes)); // { id: 7, name: 'Ada', tags: ['x', 'y'], active: true, manager: null }
console.log(decode(encode(new Float64Array([1.25, -0, Math.PI])))); // Float64Array
```

## Functional core

```ts
import { binary, read, readWhole, write, maxEncodedSize } from 'pure-cbor';
import type { Value } from 'pure-cbor';

const values: Value[] = [42, 'hello', { list: [1, 'x'] }, new Float32Array([1, 2, 3])];
const capacity = values.reduce((total, value) => total + maxEncodedSize(value), 0);
const buffer = binary(new Uint8Array(capacity));

let offset = 0;
for (const value of values) offset = write(buffer, offset, value);

// A CBOR sequence (not a CBOR array).
const used = binary(buffer.bytes.subarray(0, offset));
for (let position = 0; position < offset;) {
  const [value, next] = read(used, position);
  console.log(value);
  position = next;
}

// If the prepared view contains exactly one value, no sequence tuple is needed.
console.log(readWhole(binary(new Uint8Array([0x83, 1, 2, 3])))); // [1, 2, 3]
```

`Binary` holds a byte view. It has no cursor and deliberately no DataView: in V8, constructing a DataView on a small, freshly allocated buffer forces the buffer off-heap. That cost ~900 ns per message, more than the encode or decode itself. Writes mutate only the supplied bytes and return the next offset. Reads do not change the source. Offsets are relative to the supplied view, including subviews with a nonzero `byteOffset`.

The codecs have no hidden operation state. The shared module resources are:

- constants and a tag lookup;
- standard UTF-8 encoders/decoders, used with non-streaming calls;
- two scratch areas used only within one synchronous call: a one-element float array for float/byte conversion, and the owned-output staging buffer;
- a decoded-key cache (see below);
- one write function per non-default encode-option set, built on first use (it holds no data).

Decoding a container creates one small state record (cursor, depth, limits) for that call and passes it down explicitly.

## Allocation policies

Choose the API based on the lifetime of your data, not merely its speed.

### 1. Owned output (default)

```ts
const owned = encode({ hello: 'world' });
```

Exactly sized, with no shared backing buffer. The bytes can be retained or transferred to another worker.

### 2. Caller-owned buffer

```ts
import { binary, write, encodeInto } from 'pure-cbor';
const destination = new Uint8Array(1024);
const prepared = binary(destination);
let offset = write(prepared, 0, 42);
offset = write(prepared, offset, 'hello');
// Or encodeInto(value, destination, offset).
```

The fastest interface for scalars when you manage memory yourself. A capacity error never partially writes the destination. For arrays and objects this guarantee costs a sizing pass before writing, so owned `encode()` can be faster for objects.

### 3. Slab-backed encoder (opt-in)

```ts
import { createSlabEncoder, decode } from 'pure-cbor';
const pooled = createSlabEncoder({ slabSize: 64 * 1024, maxPooledValueSize: 16 * 1024 });
const first = pooled(42);
const second = pooled({ list: [1, 'hello'] });
console.log(first.buffer === second.buffer); // true for these two small values
console.log(decode(first)); // 42, even after later calls
```

- When it helps: outputs of 64 bytes or less are already cheap V8 on-heap allocations with `encode()`, so a slab mainly saves the ~0.5 µs off-heap allocation for larger messages.
- Allocates its slab lazily. Only one active slab is retained by the closure.
- Appends each value into disjoint memory. On rollover it allocates a new slab, and earlier returned views are never overwritten.
- Values whose encoded size exceeds `maxPooledValueSize` get exact owned output instead, so an unusually large value never grows the pool. The default threshold is one quarter of the slab size; zero disables pooling.
- Each returned view may keep its whole backing slab alive.
- Treat the returned **view** as the message, not `view.buffer`. Other messages may share the backing buffer, so don't transfer or detach it, share it with untrusted code, or write outside your slice. Use `encode()` or `Uint8Array.from(view)` for independent ownership.

`createSlabEncoder` returns a function, not a serializer class. Separate instances share nothing. Reentrant calls fall back to owned allocation.

## Streaming

A CBOR sequence (RFC 8742, media type `application/cbor-seq`) is complete CBOR items written back to back. These functions read and write sequences over Web Streams, which are built into browsers, Node ≥ 18, Deno, Bun and workerd, and over any async iterable of bytes, including Node streams.

```ts
import { decodeStream, decodeSequence, encodeSequence, encodeStream } from 'pure-cbor';

// Decode a response body item by item.
for await (const value of decodeSequence(response.body!)) handle(value);

// Or as a TransformStream: bytes in, values out.
const values = response.body!.pipeThrough(decodeStream({ maxItemBytes: 1 << 20 }));

// Batch mode: one array of values per chunk, far less Web Streams overhead.
for await (const batch of response.body!.pipeThrough(decodeStream({ batch: true }))) batch.forEach(handle);
batches.pipeThrough(encodeStream({ batch: true })).pipeTo(destination); // arrays of values in

// Stream values out as a request body. chunkBytes coalesces values into larger chunks.
await fetch(url, {
  method: 'POST', duplex: 'half', headers: { 'content-type': 'application/cbor-seq' },
  body: encodeSequence(rows, { chunkBytes: 16384 }),
});
source.pipeThrough(encodeStream()).pipeTo(destination);
```

Without streams, for example with WebSocket messages, Node `'data'` events or tests, use the incremental core directly:

```ts
import { createSequenceDecoder, createSequenceEncoder } from 'pure-cbor';

const decoder = createSequenceDecoder();
socket.onmessage = event => decoder.push(new Uint8Array(event.data), handle);
socket.onclose = () => decoder.end(); // throws `truncated` if an item was cut off

const encoder = createSequenceEncoder({ chunkBytes: 16384 });
for (const row of rows) encoder.push(row, send);
encoder.flush(send);
```

**Decoding**
- Items that sit inside a chunk are decoded in place, with nothing extra.
- An item that runs past the end of a chunk is gathered by a header-only scanner. The scanner allocates nothing and resumes where it stopped, so decoding is linear in the input whatever the chunking.
- Near the end of each chunk, items are checked with the scanner before decoding, so a cut-off item is detected without an exception.
- Malformed input reports the same error code however it's chunked.
- Errors carry absolute stream offsets.

**Limits**
- `maxItemBytes` (default 16 MiB) caps one item's encoded size. For an item that runs past the end of a chunk it's checked from headers before the bytes arrive, so a short header claiming a 4 GB string can't make the decoder buffer it. An item that arrives whole within one chunk is decoded in place and then checked.
- All decode limits (`maxDepth`, `maxArrayLength`, `maxMapEntries`, the allocation budget) apply to each item.

**Encoding**
- `chunkBytes: 0` (the default) emits one owned chunk per value: lowest latency, right for interactive transports.
- `chunkBytes: N` writes values straight into chunks and emits each once it holds at least N bytes, so chunks hold N to N + one value bytes. This is right for files and HTTP bodies.
- An unsupported value throws and leaves no partial bytes behind.

**Notes**
- `decodeSequence` cancels the source if you stop iterating early.
- `encodeSequence` pulls values lazily as the stream is read.
- A decoder that has thrown stays failed. `push` after `end()`, or from inside its own callback, throws a `TypeError`.
- With `binaryOwnership: 'borrow'`, values may alias incoming chunks. That's safe with ordinary readers, but not with producers that reuse chunk buffers, such as BYOB readers.
- **Batch mode** (`batch: true`) moves values as arrays. Each Web Streams step costs about 1 µs in Node, more than decoding a small value, so for many small values prefer batch mode, `decodeSequence` or the core. Batched `decodeStream` is within 8% of the core decoder, and batched `encodeStream` is 3.4× faster than cbor-x's Node `EncoderStream` (see BENCHMARK.md).
  - `decodeStream({ batch: true })` emits one array per input chunk that completes at least one value.
  - `encodeStream({ batch: true })` accepts arrays. With `chunkBytes: 0` it emits one chunk per array; with `chunkBytes: N` it coalesces as usual.
- Build sources that pull lazily. Enqueuing many items into a `ReadableStream` up front made Node's stream queue quadratic: 100,000 items took 2.7 s to read back.

## COSE, CWT, WebAuthn and mdoc

These formats are tested against their own specifications' examples (see [test/vectors](test/vectors/README.md)): every COSE working-group example, the RFC 8392 CWTs, all WebAuthn Level 3 attestations, and the ISO 18013-5 mobile driving licence flow.

```ts
import { binary, decode, encode, read, isTagged, tagged } from 'pure-cbor';

// COSE_Sign1: rebuild the exact bytes the signature covers.
const message = decode(bytes, { binaryOwnership: 'borrow' });   // views: much faster for byte-heavy messages
const [protectedHeader, unprotectedHeader, payload, signature] = isTagged(message) ? message.value : message;
const algorithm = decode(protectedHeader).get(1);                // integer keys decode as Map
const toBeSigned = encode(['Signature1', protectedHeader, externalAad, payload]);

// WebAuthn authenticatorData: the COSE public key has no length prefix, so
// read() decodes one item and returns where it ended (extensions may follow).
const [publicKey, next] = read(binary(authData), 55 + credentialIdLength);

// Keep tags exactly as written (e.g. to re-encode signed data byte for byte):
decode(bytes, { tags: { 0: content => tagged(0, content) } });
```

Byte strings are copied by default, so results never depend on the input buffer. Byte strings over 64 bytes from one decode share one arena, so a COSE or WebAuthn message costs about one allocation, not one per key, signature or certificate. Decoding with `binaryOwnership: 'borrow'` returns views into the input instead. That's faster still (no copy at all), and safe while the input stays unchanged. Tag 24 (embedded CBOR, used by mdoc) decodes as `Tagged(24, bytes)`; decode its value to get the inner item.

## API

| Function | Contract |
| --- | --- |
| `encode(value)` | Exact-sized, independently owned `Uint8Array`. |
| `createSlabEncoder(options?)` | A bounded, append-only slab encoder closure. |
| `decode(bytes, options?)` | Decode exactly one item; reject trailing bytes. |
| `encodeInto(value, bytes, offset = 0)` | Write into caller-owned memory, return the next offset. |
| `binary(bytes)` | Validate and wrap a byte view for reuse. |
| `write(binary, offset, value)` | Prepared-buffer write, with bounds checks. |
| `read(binary, offset, options?)` | Read one item; return `[value, nextOffset]`. May leave trailing bytes. |
| `readWhole(binary, options?)` | Read exactly one item from a prepared view; no result tuple. |
| `encodedSize(value)` | Exact encoded size. Strings may need a UTF-8 sizing pass. |
| `maxEncodedSize(value)` | Upper bound. Exact for numbers, typed arrays and numeric-only arrays. |
| `tryDecode(bytes, options?)` | Discriminated `Result`; catches library validation errors, not arbitrary programmer/runtime errors. |
| `createSequenceDecoder(options?)` | Incremental CBOR-sequence decoder: `push(chunk, onValue)`, `end()`. |
| `createSequenceEncoder(options?)` | Sequence encoder: `push(value, onChunk)`, `flush(onChunk)`. |
| `decodeStream(options?)` | `TransformStream` from bytes to values, or to arrays of values with `batch: true`. |
| `encodeStream(options?)` | `TransformStream` from values, or arrays of values with `batch: true`, to bytes. |
| `decodeSequence(source, options?)` | Async generator of values from a `ReadableStream` or (async) iterable of byte chunks. |
| `encodeSequence(values, options?)` | `ReadableStream` of bytes from an iterable or async iterable of values. |

Inputs must be stable during a call: no accessors that change values, proxies, or concurrent mutation (the sizing and writing passes assume stable values). Don't forge `Binary` descriptors, or resize or detach buffers during an operation. Allocation can fail with a native runtime error for excessively large values.

## Wire types

```ts
type Scalar = number | bigint | string | boolean | null | undefined;
type Value = Scalar | TypedArray | Date | Tagged | SimpleValue
  | readonly Value[] | ReadonlyMap<Value, Value> | ValueObject;
interface ValueObject { readonly [key: string]: Value }
interface Tagged { readonly tag: number; readonly value: Value }   // tagged(tag, value)
interface SimpleValue { readonly simple: number }                  // simple(n)
```

`Tagged` and `SimpleValue` are immutable variants made by `tagged()` and `simple()`. They're recognized by a private prototype, so a plain object with the same fields is just an object.

| CBOR | Encode from | Decode to |
| --- | --- | --- |
| Integers (major 0, 1) | `number` safe integers, `bigint` | `number`; `bigint` beyond ±2^53 |
| Bignums (tags 2, 3) | `bigint` beyond 64 bits | `bigint` |
| Floats | other `number`s, as binary64 (or shortest, see below) | `number` (binary16/32/64) |
| Text, byte strings | `string`, `Uint8Array` | `string`, `Uint8Array` (also from indefinite-length chunks) |
| Arrays | arrays (holes and `undefined` as `f7`) | arrays (definite or indefinite) |
| Maps | plain objects (text keys); `Map` (any keys) | objects when every key is text, else `Map` (option `maps`) |
| `false`, `true`, `null`, `undefined` | the same | the same |
| Other simple values | `simple(n)` | `SimpleValue` |
| Date/time (tags 0, 1) | `Date`, as tag 1 epoch seconds | `Date` (millisecond precision) |
| RFC 8746 typed arrays | eleven `TypedArray` kinds | the same (either endianness) |
| Self-described (tag 55799) | — | its content |
| Any other tag | `tagged(tag, value)` | `Tagged` (or your decoder via `tags`) |

Notes:

- **Integers and floats.** Safe integers always encode as CBOR integers in their preferred width, so millisecond timestamps reach other languages as integers. `5n` encodes like `5`, because CBOR has one integer type, so it decodes as the number `5`. cbor-x decodes 64-bit integers as `BigInt` unless created with `int64AsNumber: true`.
- **Objects:**
  - Encoding takes own enumerable string keys in `Object.keys` order, with the preferred header. Properties set to `undefined` are omitted, as in JSON. Symbol keys are ignored. `Set`, class instances and boxed primitives are rejected rather than silently flattened.
  - A `__proto__` key decodes as an own data property: no prototype pollution, no renaming.
- **Maps.** In the default `'auto'` mode, a map whose keys are all text decodes as a plain object, so a `Map` with only string keys comes back as an object. Use `maps: 'map'` to always get `Map`. Byte-string and other object keys are distinct by identity in a JS `Map`.
- **Duplicate keys** are rejected by default (`duplicateKeys: 'last-wins'` to keep the last). For `Map`, only equal primitive keys can be detected.
- **Indefinite-length items** (`5f`, `7f`, `9f`, `bf` … `ff`) are accepted on decode, including in streams. pure-cbor always encodes definite lengths. Text chunks must each be valid UTF-8 (RFC 8949 §3.2.3).

### Encode options

```ts
encode(value, { floats: 'shortest' });   // smallest exact float width: 1.5 -> f93e00
encode(value, { deterministic: true });  // RFC 8949 §4.2.1: shortest floats + keys sorted by encoded bytes
```

The same options apply to `encodeInto`, `write`, `encodedSize`, `maxEncodedSize`, `createSlabEncoder` and the sequence and stream encoders.

- **Default:** fastest. Floats are binary64 (cbor-x does the same).
- **`floats: 'shortest'`:** uses binary16 or binary32 wherever they hold the value exactly. NaN becomes the canonical `f97e00`.
- **`deterministic: true`:** produces canonical bytes for hashing and signing. Keys that encode identically (such as `1` and `1n` in one `Map`) are a `duplicate-key` error. These modes run through a separate writer, so the default path never checks options.

Not supported: `Set`, `DataView`, bare `ArrayBuffer`, `Float16Array` and the float16/float128 typed-array tags (80, 83, 84, 87), multi-dimensional arrays (tag 40), tag numbers beyond 2^53, cbor-x records and packing, encoding indefinite lengths, diagnostic notation, CDDL. Non-preferred argument widths are accepted when decoding.

### Decode options and limits

```ts
decode(wire, { binaryOwnership: 'borrow' });   // views into the input; default 'copy' (see below)
decode(wire, { invalidUtf8: 'replace' });      // default 'reject'
decode(wire, { maxArrayLength: 10_000 });      // default 1,000,000 per array
decode(wire, { maxMapEntries: 1_000 });        // default 1,000,000 per map
decode(wire, { maxDepth: 32 });                // default 128 nested arrays/maps
decode(wire, { duplicateKeys: 'last-wins' });  // default 'reject'
decode(wire, { maps: 'map' });                 // 'auto' (default), 'object' or 'map'
decode(wire, { tags: { 42: cidFromBytes } });  // your tag decoders; they take precedence
decode(wire, { unknownTags: 'reject' });       // default 'tagged'
```

- Every container's declared length is checked against its limit and the remaining input before anything is allocated.
- A per-decode item budget, bounded by the input length, stops a chain of nested headers from preallocating far more than the message could contain.
- Deep input fails with `depth-limit` instead of overflowing the stack. Tags count toward depth too.
- Encoding enforces the same depth limit, which also turns cyclic input into a typed `depth-limit` error.

This isn't a full memory-budget guarantee; apply message byte limits at the transport boundary too.

- **Byte ownership:**
  - `'copy'` (default): byte strings are copied, so they're independent of the input. Those over 64 bytes from one decode share a per-decode arena, sized to what remains of the input (at most 64 KiB unless one byte string needs more). So one result can keep its siblings' bytes alive, and transferring one result's `buffer` to a worker would take its siblings with it.
  - `'copy-separate'`: every byte string and typed array gets its own exactly sized buffer.
  - `'borrow'`: views into the input wherever possible; aligned, native-endian typed arrays become views and others are copied. A small borrowed result can keep a large input alive.
- Strict UTF-8 validation is the default. A leading U+FEFF is preserved. Lone UTF-16 surrogates encode as U+FFFD.

Error codes: `truncated`, `capacity`, `invalid-offset`, `invalid-header`, `invalid-length`, `invalid-utf8`, `integer-overflow`, `array-limit`, `map-limit`, `depth-limit`, `item-limit`, `duplicate-key`, `unsupported-type`, `unsupported-tag`, `invalid-tag-content`, `trailing-data`, `invalid-buffer`.

## Architecture

```
index.ts           public API
allocation.ts      owned (staging) and optional slab policies
codec.ts           major-type dispatch for reading and writing, sizing
state.ts           per-decode state: cursor, depth, limits, item budget
writer.ts          output cursor; growable (owned) or fixed (caller memory)
sequence.ts        CBOR sequences: resumable item scanner, incremental decoder and encoder
stream.ts          Web Streams and async-iterator adapters over sequence.ts
array.ts           arrays: inline scalar loops, nested items via the dispatcher
map.ts             objects and Map: enumeration, keys, modes, duplicates, sorted (deterministic) entries
keys.ts            decoded-key cache
scalar.ts          shared scalar writer for the dispatcher
number.ts          numbers
string.ts          UTF-8 and short ASCII paths
simple.ts          major type 7: false/true/null/undefined, SimpleValue, float dispatch
tag.ts             Tagged, dates, built-in and custom tag decoding
bignum.ts          bigint <-> 64-bit integers and bignums (tags 2, 3)
indefinite.ts      indefinite-length byte and text strings
typed-array.ts     typed-array tags, payload ownership, byte order
header.ts          CBOR argument primitives
binary.ts          view descriptor, bounds, endian constant
error.ts           error codes, CborError and Result
types.ts           value and option types
```

The dependency graph is acyclic. Container codecs receive the item dispatcher as a parameter instead of importing it, and no codec depends on allocation policy. `CborError` is the only class, used on the cold error path.

### Performance choices

Each choice below was measured, and the reasons are also commented in the code.

- **No DataView** for scalars. Headers and integers are read and written byte by byte, and floats convert through a tiny scratch array. Small owned outputs and fresh inputs stay cheap on-heap allocations. Float-heavy arrays over 64 bytes create one DataView lazily, because such inputs are already off-heap.
- **Owned encoding** writes once into a reusable staging buffer (up to 64 KiB, growable), then copies out exactly once. That's one output allocation and no sizing pass. In V8 every typed array over 64 bytes is a separate ~0.5 µs off-heap allocation, so allocation count dominates.
- **Array and map loops** keep the cursor in a local variable and write scalars inline. A shared helper measured 10–20% slower because V8 declined to inline it there.
- **Object enumeration** uses `for…in`, which reads through V8's enum cache with no allocations: about 3× faster than `Object.keys` + `Object.values`. An own-property check is added only if `Object.prototype` has gained enumerable properties, so a polluted prototype never leaks keys. The map header is reserved as 1 byte and filled in last; maps with 24 or more entries shift their entries to keep the preferred header.
- **Decoded-key cache:** a 1,024-slot table returns the same string for repeated keys of up to 32 bytes. Hits are confirmed byte for byte, and only keys that decoded as valid UTF-8 are stored. One-character ASCII keys bypass it, because V8 already interns those.
- **Duplicate keys** are detected by comparing the object's key count with the entry count once per map, about 4× cheaper than checking each key. The error points at the map header.
- **Array decode** preallocates the result (1.6× faster than `push`; holey arrays had no measurable cost for consumers) and decodes scalars inline with no per-element tuples.
- **Short ASCII text** (up to 32 bytes) is checked 8 bytes at a time, with tails built by a single exact-arity `fromCharCode` call. Short non-ASCII text uses a strict JS UTF-8 decoder that defers to `TextDecoder` on anything malformed, so strict and replacement semantics are exactly the native ones.
- **Typed arrays** use bulk `Uint8Array.set`. Overlapping source and destination views are supported.

## Tests and benchmarks

```sh
npm run lint                   # type check with strict extras: unused code, implicit returns, switch fall-through
npm test
npm run bench                  # all workloads in one process (quick look)
npm run bench:isolated         # one process per workload, vs every installed library (bench/libraries.mjs)
npm run bench:stream           # streaming: sequence decoder/encoder and Web Streams vs cbor-x streams
npm run bench:json             # vs the built-in JSON.stringify / JSON.parse
npm run bench:cose             # WebAuthn, COSE, CWT and mdoc flows on spec vectors, vs CBOR libraries
```

`npm test` includes a portable conformance suite, [test/portable/suite.mjs](test/portable/suite.mjs): RFC 8949 Appendix A, round trips of every value kind, errors, byte-string ownership, and sequences and Web Streams under every chunking. It uses no Node APIs, so CI runs the same file in every other runtime (Deno also runs the whole Node suite):

```sh
deno run test/portable/run.mjs
bun test/portable/run.mjs
npm install --no-save playwright && npx playwright install && node test/portable/browsers.mjs
npm install --no-save miniflare && node test/portable/miniflare.mjs   # workerd
```

Optional comparisons and differential tests: random nested trees both ways with cbor-x, and the corpus both ways with cbor-x and cborg. Short-text decoding is checked against `TextDecoder` either way.

```sh
npm install --no-save --package-lock=false cbor-x cborg @levischuck/tiny-cbor cbor cbor2 cbor-js msgpackr @msgpack/msgpack
npm test
npm run bench:isolated
```

The benchmark includes a public corpus in [bench/corpus](bench/corpus/README.md): cbor-x's own benchmark document, @msgpack/msgpack's sample data, and seeded Bluesky-style records and float meshes shaped like cborg's and rust_serialization_benchmark's workloads. `BENCH_MS`, `BENCH_ROUNDS` and `BENCH_FILTER` control timing and workload selection. Compare workloads with `bench:isolated`: workloads sharing a process skew each other's V8 type feedback by up to 2×. The harness disables cbor-x's native string extraction, so it compares pure JS with pure JS. Benchmarked on Node 22 only; browser and workerd performance remain unverified.

## Releasing

Releases are published from GitHub Actions with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token exists anywhere, and each version carries provenance linking it to the commit and workflow run that built it.

1. Bump the version and add a CHANGELOG entry: `npm version patch` (or `minor`, `major`) commits and tags `vX.Y.Z`.
2. `git push --follow-tags`.
3. CI runs lint, the tests on Node 22, 24 and latest, the interoperability tests, a packed-tarball check, the whole suite on Deno, and the portable suite on Bun, workerd and three browsers. The `publish` job then waits for approval of the `npm` environment, which accepts only `v*` tags.
