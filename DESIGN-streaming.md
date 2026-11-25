# Design proposal: streaming (pure-cbor 0.4)

Status: **implemented in 0.4.0** with the recommended defaults: optimistic in-chunk decoding with a resumable scanner, `maxItemBytes` 16 MiB, `chunkBytes: 0`, no `maxDelayMs`, and the proposed names. Results are in BENCHMARK.md ("Streaming").

Differences from this proposal, each made after measuring:

- **Scan ahead near chunk ends.** In the last 1 KiB of a chunk, an item's boundary is checked with the scanner before decoding, so a cut-off item is detected without an exception. Stack-trace capture for those exceptions cost about 3.7 µs per boundary: 1 KiB chunks went from 55 ms to 35 ms per 100,000 rows.
- **Same errors under any chunking.** The scanner checks array and map limits in the same order as the decoder, using one shared limit validator. It leaves every non-length error to the decoder, so malformed input reports the same code wherever chunk boundaries fall. A test checks this for every chunk size.
- **Coalesced encoding** writes into a growable chunk, so chunks hold `chunkBytes` to `chunkBytes` + one value bytes, rather than splitting a value across two writes.
- **A new error code, `item-limit`,** for `maxItemBytes`.
- **Batch mode** (`batch: true`) on `decodeStream` and `encodeStream`, added after measuring Node's Web Streams at about 1 µs per step. Values move as one array per chunk: decoding went from 51 ms to 26 ms per 100,000 rows, and encoding from 127 ms to 19 ms.
- **The coalescing encoder's first buffer** is capped at 64 KiB and grows as needed, so a large `chunkBytes` doesn't allocate its full size up front.

The original proposal follows unchanged.

## 1. Goals

- Encode and decode **CBOR sequences** (RFC 8742, media type `application/cbor-seq`): complete CBOR items written back to back with no extra framing. Any CBOR decoder can read one item at a time, and any producer can append.
- Use **WHATWG Web Streams** (`ReadableStream`, `WritableStream`, `TransformStream`), which are built into browsers, Node ≥ 18, Deno, Bun and Cloudflare workerd. No Node APIs. Node's own streams work too, because they are async iterable.
- **Linear time** whatever the chunking: an item split across thousands of chunks costs no more than one that arrives whole.
- **Bounded memory** against hostile input: a header claiming a 4 GB string must not make us buffer 4 GB.
- **Near-zero overhead** in the common case where items sit wholly inside a chunk. Streaming throughput should stay within about 10% of decoding the same items with `decode()`.
- Keep the library's style: functional (factory functions and closures, no classes), explicit state, typed `CborError`s, no code generation.

Non-goals for 0.4: indefinite-length items (still unsupported), streaming the elements of one huge top-level array (see §9), cbor-x-style records, tags.

## 2. Why this fits pure-cbor especially well

Stream chunks are **fresh buffers**, and fresh input is where pure-cbor is far ahead: 10–14× faster than cbor-x and cborg on small values, because it never builds a DataView over a fresh small buffer (BENCHMARK.md, "Decode (fresh input)"). A streaming decoder that keeps that property should beat cbor-x's `DecoderStream` comfortably on small-message streams.

## 3. Layers

```
sequence.ts   pure, environment-free incremental core (no stream APIs)
  createSequenceDecoder(options) -> { push(chunk, onValue), end() }
  createSequenceEncoder(options) -> { push(value, onChunk), flush(onChunk) }
  scanItem(bytes, offset, scanState)  resumable item-boundary scanner

stream.ts     thin Web Streams / async-iterator adapters over the core
  decodeStream(options)        TransformStream<Uint8Array, Value>
  encodeStream(options)        TransformStream<Value, Uint8Array>
  decodeSequence(source, opts) AsyncGenerator<Value>    (ReadableStream or any AsyncIterable of bytes)
  encodeSequence(values, opts) ReadableStream<Uint8Array> (from an Iterable or AsyncIterable)
```

The core can be used without streams, for example with WebSocket messages, Node `'data'` events or tests. The stream functions are about 60 lines of glue, and they only touch stream globals when called, so `sideEffects: false` and tree-shaking still hold.

## 4. Decoding

### 4.1 Finding item boundaries: optimistic decode, then a resumable scanner

The decoder keeps the unconsumed bytes of the current chunk. For each item:

1. **Fast path: decode in place.** Call `read(binary(chunk), offset)` directly on the chunk. When the item is complete in the chunk, which is almost always, this is exactly the normal decode with nothing added.
2. **Boundary: an item runs off the end of the chunk.** The decode throws `truncated`. That happens at most once per chunk, and the wasted work is at most the partial item. The decoder then switches to the **scanner**.
3. **Scanner.** `scanItem` walks only headers and skips payloads by length. It allocates nothing, decodes no strings, and uses no recursion: one counter of items still expected (an array adds n, a map 2n, a tag 1). It can stop at any byte and **resume** later from its saved `{ position, itemsPending }`. So an item spread over many chunks is scanned once in total, with no rescanning from the start.
4. **Assembly.** While scanning, the item's bytes are copied into one assembly buffer that grows geometrically. When the scanner reports the item complete, it is decoded once from that buffer. The assembly buffer is new for each spanning item, so values that borrow from it (`binaryOwnership: 'borrow'`) stay valid.

The result is linear in total bytes. There is one exception (`truncated`) per chunk boundary at most. Items inside a chunk get no extra pass, and only items that span chunks are scanned and then decoded.

**(decide)** The alternative is to always scan, then decode. That's simpler (no exception on the normal path), but it adds a header walk to every item, which I estimate costs 15–30% on small-item streams. I recommend optimistic decode plus the scanner, and measuring both.

### 4.2 Limits and errors

- **`maxItemBytes`** (new, default **16 MiB**, **(decide)**) caps one item's encoded size. It bounds buffering, because the scanner knows each declared payload length before the bytes arrive and fails as soon as the item would exceed the cap. Without it, a 9-byte header could make us buffer gigabytes.
- All existing per-item limits (`maxDepth`, `maxArrayLength`, `maxMapEntries`, the allocation budget) apply per item, unchanged.
- **Offsets in errors are absolute stream offsets** (bytes since the stream started), not offsets within a chunk, so errors point at the right place in a capture of the stream.
- End of input with a partial item buffered → `truncated` at the item's start offset. End of input with nothing pending → clean close.
- A decode error makes the stream error (the TransformStream errors both sides). `decodeSequence` rethrows from the iterator.

### 4.3 Backpressure

`TransformStream` provides backpressure: `transform()` is not called again until the readable side has room. One chunk can still produce many values at once (64 KiB of 1-byte integers is 65,536 values). The decoder emits them in a loop and does not pause in the middle of a chunk; producers control this through chunk size. Strategies can be passed through (`writableStrategy`, `readableStrategy`); the defaults are the TransformStream defaults.

## 5. Encoding

- **`encodeStream({ chunkBytes })`**: values in, `Uint8Array` chunks out.
  - `chunkBytes: 0` writes **one chunk per value**: lowest latency, right for interactive transports such as WebSockets and server-sent messages.
  - `chunkBytes: N` writes **coalesced chunks of up to N bytes**. Values are written directly into the current chunk with the caller-owned-buffer path (`writeBytes`), so there is no allocation per value and no copying. When a value doesn't fit, the chunk is emitted and a new one started. A value larger than N gets its own exactly sized chunk. On close, the partial chunk is emitted. This is right for files, HTTP bodies and pipes, where fewer, larger writes matter.
- **(decide)** Default `chunkBytes`. I recommend **0** (immediate), because it is predictable in interactive pipelines: a coalescing default can sit on a small value until more values or the end of the stream arrive. Throughput users opt into `chunkBytes: 16384`. The alternative is 16 KiB by default with an explicit flush.
- Emitted chunks are fresh, independently owned `Uint8Array`s, safe to transfer, unlike slab views.
- **(decide)** Whether to add `maxDelayMs` (flush a partial chunk after a delay) for latency-bounded batching. I recommend leaving it out: it brings timers into a pure library, and `chunkBytes: 0` or closing the stream covers most cases.

## 6. Public API sketch

```ts
// Web Streams
const values = response.body!.pipeThrough(decodeStream({ maxItemBytes: 1 << 20 }));
for await (const value of decodeSequence(values /* or any byte stream */)) { ... }

const body = encodeSequence(rows, { chunkBytes: 16384 });   // ReadableStream<Uint8Array>
await fetch(url, { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/cbor-seq' } });

source.pipeThrough(encodeStream()).pipeTo(socketWritable);

// Without streams
const decoder = createSequenceDecoder(options);
socket.onmessage = event => decoder.push(new Uint8Array(event.data), handleValue);
socket.onclose = () => decoder.end();               // throws 'truncated' if an item is incomplete
```

Types:

```ts
interface SequenceDecodeOptions extends DecodeOptions { readonly maxItemBytes?: number }
interface SequenceEncodeOptions { readonly chunkBytes?: number }
interface SequenceDecoder {
  push(chunk: Uint8Array, onValue: (value: Value) => void): void;
  end(): void;
  readonly bufferedBytes: number;   // bytes held for an incomplete item
  readonly offset: number;          // absolute bytes consumed
}
```

The callback form (`push(chunk, onValue)`) allocates nothing per call and maps directly onto `controller.enqueue`. `decodeSequence` builds on it with a small queue.

**(decide)** Naming. I recommend `decodeStream`/`encodeStream` for the TransformStreams and `decodeSequence`/`encodeSequence` for the iterator and producer helpers, matching `encode`/`decode`. The alternative is `createDecoderStream`, mirroring `createSlabEncoder`.

## 7. Ownership and safety notes

- Decoded values **copy** byte and typed-array payloads by default, as now.
- With `binaryOwnership: 'borrow'`, values may alias the incoming chunk (for items inside one chunk) or the item's own assembly buffer (for spanning items). Both are safe with default readers, which hand chunk ownership to the consumer. It is **not** safe with BYOB readers or producers that reuse chunk buffers; that will be documented.
- No module-level state is added. Each decoder or encoder closure owns its buffers.
- Re-entrancy: if an `onValue` callback calls `push` on the same decoder, that is rejected with a clear error instead of corrupting state.

## 8. Tests

- **Every split:** for a corpus of sequences (scalars, nested objects, the public corpus, typed arrays), feed it split at **every byte position**, and in random chunk sizes from 1 byte to 64 KiB. The output must equal decoding each item whole.
- **Linear time:** a 16 MiB string fed in 1 KiB chunks finishes within a fixed bound, so quadratic rescanning would fail the test.
- **Limits:** `maxItemBytes` trips before buffering, using a header claiming 4 GB; all per-item limits still apply; truncation at end of input; absolute error offsets.
- **Streams:** `pipeThrough` and `pipeTo` round trips; early `break` in `for await` cancels the source; encode with `chunkBytes` 0 and N produces byte-identical output to concatenating `encode()` results.
- **Interop:** decode cbor-x `EncoderStream` output (standard mode); cbor-x `DecoderStream` and `cborg.decodeFirst` read ours.

## 9. Later, not in 0.4

- **Element streaming for one huge top-level array** (`decodeElements`): yield the elements of a definite-length array as they arrive, for "one giant JSON-like array" exports. The scanner design supports it: track depth 1 and emit at each element boundary. It changes the error and offset semantics, so it deserves its own pass.
- `maxDelayMs` batching, if real use needs it.

## 10. Benchmarks

Add to `bench:isolated`:

| Workload | Comparison |
| --- | --- |
| 100,000 small objects (the `object: row` shape) as a sequence in 64 KiB chunks | cbor-x `DecoderStream`/`EncoderStream` (Node streams); `decode()` on the same items for streaming overhead |
| Same, in 1 KiB chunks | stresses item boundaries |
| One 8 MiB float mesh in 16 KiB chunks | stresses spanning items |
| Encode: 100,000 rows, `chunkBytes` 0 vs 16384 | cbor-x `EncoderStream` |

cborg has no streaming decoder (only `decodeFirst`), so it would only appear in an item-by-item loop comparison.

## 11. Implementation plan

1. `sequence.ts`: the scanner, decoder core and encoder core, with the every-split and linear-time tests.
2. `stream.ts`: Web Streams and async-iterator adapters, with stream tests and interop.
3. Benchmarks, README and BENCHMARK.md, version 0.4.0.
