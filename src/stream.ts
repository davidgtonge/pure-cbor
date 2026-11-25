import { fail } from './error.js';
import { createSequenceDecoder, createSequenceEncoder } from './sequence.js';
import type { SequenceDecodeOptions, SequenceEncodeOptions } from './sequence.js';
import type { Value } from './types.js';

// Web Streams (browsers, Node >= 18, Deno, Bun, workerd) and async-iterator
// adapters over the incremental core in sequence.ts. Stream globals are only
// touched when these functions are called.

export interface DecodeStreamOptions extends SequenceDecodeOptions {
  readonly batch?: false;
  readonly writableStrategy?: QueuingStrategy<BufferSource>;
  readonly readableStrategy?: QueuingStrategy<Value>;
}

/** Emit one array per input chunk, holding the values that chunk completed. */
export interface BatchDecodeStreamOptions extends SequenceDecodeOptions {
  readonly batch: true;
  readonly writableStrategy?: QueuingStrategy<BufferSource>;
  readonly readableStrategy?: QueuingStrategy<Value[]>;
}

export interface EncodeStreamOptions extends SequenceEncodeOptions {
  readonly batch?: false;
  readonly writableStrategy?: QueuingStrategy<Value>;
  readonly readableStrategy?: QueuingStrategy<Uint8Array>;
}

/** Accept arrays of values. With chunkBytes 0, each array becomes one chunk. */
export interface BatchEncodeStreamOptions extends SequenceEncodeOptions {
  readonly batch: true;
  readonly writableStrategy?: QueuingStrategy<readonly Value[]>;
  readonly readableStrategy?: QueuingStrategy<Uint8Array>;
}

type ByteSource = ReadableStream<BufferSource> | AsyncIterable<BufferSource> | Iterable<BufferSource>;

/** Accept Uint8Array (including Node Buffer), other views and ArrayBuffer. */
function asBytes(chunk: BufferSource): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return fail('invalid-buffer', 0, 'Stream chunks must be Uint8Array, ArrayBuffer or an ArrayBuffer view');
}

// Batch modes exist because each Web Streams step costs about 1 µs per chunk
// in Node, more than decoding or encoding a small value. Moving values as
// arrays pays that cost once per chunk instead of once per value.

/** Bytes in, decoded values out; with `batch: true`, arrays of values out.
 * Decode errors error the stream. */
export function decodeStream(options?: DecodeStreamOptions): TransformStream<BufferSource, Value>;
export function decodeStream(options: BatchDecodeStreamOptions): TransformStream<BufferSource, Value[]>;
export function decodeStream(options: DecodeStreamOptions | BatchDecodeStreamOptions = {}): TransformStream<BufferSource, Value | Value[]> {
  const decoder = createSequenceDecoder(options);
  const strategies = [options.writableStrategy, options.readableStrategy as QueuingStrategy<Value | Value[]>] as const;
  if (options.batch) {
    return new TransformStream<BufferSource, Value[]>({
      transform(chunk, controller) {
        const values: Value[] = [];
        decoder.push(asBytes(chunk), value => { values.push(value); });
        if (values.length > 0) controller.enqueue(values);
      },
      flush() { decoder.end(); },
    }, ...strategies);
  }
  let enqueue: (value: Value) => void;
  return new TransformStream<BufferSource, Value>({
    start(controller) { enqueue = value => controller.enqueue(value); },
    transform(chunk) { decoder.push(asBytes(chunk), enqueue); },
    flush() { decoder.end(); },
  }, ...strategies);
}

/** Values in, encoded bytes out (see SequenceEncodeOptions.chunkBytes); with
 * `batch: true`, arrays of values in. */
export function encodeStream(options?: EncodeStreamOptions): TransformStream<Value, Uint8Array>;
export function encodeStream(options: BatchEncodeStreamOptions): TransformStream<readonly Value[], Uint8Array>;
export function encodeStream(options: EncodeStreamOptions | BatchEncodeStreamOptions = {}): TransformStream<Value | readonly Value[], Uint8Array> {
  const chunkBytes = options.chunkBytes ?? 0;
  // Batches with chunkBytes 0: one chunk per batch, so an encoder that never
  // fills up and is flushed after each batch.
  const perBatch = options.batch === true && chunkBytes === 0;
  const encoder = createSequenceEncoder({ ...options, chunkBytes: perBatch ? Number.MAX_SAFE_INTEGER : chunkBytes });
  const strategies = [options.writableStrategy as QueuingStrategy<Value | readonly Value[]>, options.readableStrategy] as const;
  let enqueue: (chunk: Uint8Array) => void;
  if (options.batch) {
    return new TransformStream<readonly Value[], Uint8Array>({
      start(controller) { enqueue = chunk => controller.enqueue(chunk); },
      transform(values) {
        if (!Array.isArray(values)) fail('unsupported-type', 0, 'Batch encodeStream expects arrays of values');
        for (let index = 0; index < values.length; index++) encoder.push(values[index], enqueue);
        if (perBatch) encoder.flush(enqueue);
      },
      flush() { encoder.flush(enqueue); },
    }, ...strategies);
  }
  return new TransformStream<Value, Uint8Array>({
    start(controller) { enqueue = chunk => controller.enqueue(chunk); },
    transform(value) { encoder.push(value, enqueue); },
    flush() { encoder.flush(enqueue); },
  }, ...strategies);
}

function isReadableStream(source: unknown): source is ReadableStream<BufferSource> {
  return typeof (source as ReadableStream).getReader === 'function';
}

/** Read a ReadableStream through a reader: works where streams are not async
 * iterable, and cancels the stream if the consumer stops early. */
function readerIterator(stream: ReadableStream<BufferSource>): AsyncIterator<BufferSource> {
  const reader = stream.getReader();
  return {
    next: () => reader.read() as Promise<IteratorResult<BufferSource>>,
    async return() {
      await reader.cancel();
      reader.releaseLock();
      return { done: true, value: undefined };
    },
  };
}

/** Decode a CBOR sequence from a byte stream or any (async) iterable of byte
 * chunks, such as fetch's response.body or a Node Readable. Stopping early
 * (break, return or throw in for await) cancels the source. */
export async function* decodeSequence(source: ByteSource, options: SequenceDecodeOptions = {}): AsyncGenerator<Value, void, undefined> {
  const decoder = createSequenceDecoder(options);
  const decoded: Value[] = [];
  const collect = (value: Value): void => { decoded.push(value); };
  const iterator: AsyncIterator<BufferSource> | Iterator<BufferSource> = isReadableStream(source)
    ? readerIterator(source)
    : Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  let finished = false;
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      decoder.push(asBytes(step.value), collect);
      for (let index = 0; index < decoded.length; index++) yield decoded[index];
      decoded.length = 0;
    }
    finished = true;
    decoder.end();
  } finally {
    if (!finished) await iterator.return?.();
  }
}

/** Encode values from an iterable or async iterable as a byte stream, for
 * example a fetch request body. Values are pulled only as the stream is read. */
export function encodeSequence(values: Iterable<Value> | AsyncIterable<Value>, options: SequenceEncodeOptions = {}): ReadableStream<Uint8Array> {
  const encoder = createSequenceEncoder(options);
  const iterator: AsyncIterator<Value> | Iterator<Value> = Symbol.asyncIterator in values
    ? (values as AsyncIterable<Value>)[Symbol.asyncIterator]()
    : (values as Iterable<Value>)[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let emitted = false;
      const enqueue = (chunk: Uint8Array): void => { emitted = true; controller.enqueue(chunk); };
      // Keep pulling values until a chunk is produced: with chunkBytes, several
      // values go into each chunk.
      for (;;) {
        const step = await iterator.next();
        if (step.done) {
          encoder.flush(enqueue);
          controller.close();
          return;
        }
        encoder.push(step.value, enqueue);
        if (emitted) return;
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}
