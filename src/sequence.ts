import { binary } from './binary.js';
import { readArgumentValue, readUint32, Info, Major, Token } from './header.js';
import { read, readWhole, writerFor } from './codec.js';
import { encode } from './allocation.js';
import { CborError, fail } from './error.js';
import { containerLimits } from './state.js';
import type { ContainerLimits } from './state.js';
import { createWriter, profileOf } from './writer.js';
import type { Writer } from './writer.js';
import type { DecodeOptions, EncodeOptions, Value } from './types.js';

// CBOR sequences (RFC 8742): complete CBOR items written back to back.
// This module is the environment-free incremental core; stream.ts adapts it
// to Web Streams and async iterators.

const DEFAULT_MAX_ITEM_BYTES = 16 * 1024 * 1024;
/** While assembling an item that spans chunks, copy at least this much of each
 * new chunk at a time: few copies, and little copied past the item's end. */
const ASSEMBLY_BLOCK = 4096;
const NO_BYTES = new Uint8Array(0);
/** Near the end of a chunk, check an item's boundary with the scanner before
 * decoding it. A cut-off item is then detected without an exception, whose
 * stack-trace capture measured ~3.7 µs per chunk boundary. */
const SCAN_AHEAD_BYTES = 1024;

export interface SequenceDecodeOptions extends DecodeOptions {
  /** Largest encoded size of one item. Bounds the bytes buffered for an item
   * that spans chunks; for those it is checked from headers before the bytes
   * arrive. An item already whole within one chunk is checked after decoding.
   * Default 16 MiB. */
  readonly maxItemBytes?: number;
}

export interface SequenceDecoder {
  /** Decode every item that `chunk` completes, calling onValue for each in
   * order. Bytes of an incomplete trailing item are kept for the next push. */
  push(chunk: Uint8Array, onValue: (value: Value) => void): void;
  /** Signal the end of input; throws `truncated` if an item is incomplete. */
  end(): void;
  /** Bytes held for an incomplete item. */
  readonly bufferedBytes: number;
  /** Total bytes pushed so far (the absolute offset of the next chunk). */
  readonly offset: number;
}

/** Rebase an error's offset from a buffer-local position to the stream. */
function atStreamOffset(error: unknown, base: number): unknown {
  return error instanceof CborError ? new CborError(error.code, base + error.offset, error.message) : error;
}

// ---------------------------------------------------------------- scanning

/** Resumable boundary scan of one item starting at `start` in `bytes`, of
 * which `[start, end)` is available. Walks headers only, skipping payloads by
 * their declared length: no decoding, no allocation, no recursion.
 * `position` may run past `end` while a payload is still arriving. */
interface ScanState {
  position: number;
  /** Items still to be seen at the innermost definite level: an array adds its
   * length, a map twice its entry count, a tag one. */
  itemsPending: number;
  /** For each open indefinite-length item, the itemsPending to restore at its break. */
  readonly openIndefinite: number[];
}

function resetScan(scan: ScanState, position: number): void {
  scan.position = position;
  scan.itemsPending = 1;
  scan.openIndefinite.length = 0;
}

/** A malformed header: end the item just after it, so the decoder reads up to
 * this point and reports the error itself. The error is then the same
 * wherever chunk boundaries fall. */
function deferToDecoder(scan: ScanState, headerOffset: number): number {
  scan.position = headerOffset + 1;
  scan.itemsPending = 0;
  scan.openIndefinite.length = 0;
  return 0;
}

/** Bytes still needed before the scan can continue, or 0 when the item is
 * complete (its end is then scan.position). Error offsets are relative to `start`. */
function scanItem(bytes: Uint8Array, start: number, end: number, scan: ScanState, maxItemBytes: number, limits: ContainerLimits): number {
  while (scan.itemsPending > 0 || scan.openIndefinite.length > 0) {
    if (scan.position >= end) return scan.position - end + 1;
    const headerOffset = scan.position;
    const token = bytes[headerOffset];
    const additionalInfo = token & 31;
    const majorType = token >>> 5;
    // Directly inside an open indefinite-length item: its children are not counted.
    const atIndefiniteLevel = scan.itemsPending === 0;
    if (token === Token.Break) {
      if (!atIndefiniteLevel) return deferToDecoder(scan, headerOffset);
      scan.itemsPending = scan.openIndefinite.pop()!;
      scan.position = headerOffset + 1;
      continue;
    }
    if (additionalInfo === Info.Indefinite) {
      if (majorType < Major.Bytes || majorType > Major.Map) return deferToDecoder(scan, headerOffset);
      if (!atIndefiniteLevel) scan.itemsPending--;
      scan.openIndefinite.push(scan.itemsPending);
      scan.itemsPending = 0;
      scan.position = headerOffset + 1;
    } else {
      if (additionalInfo > Info.EightBytes) return deferToDecoder(scan, headerOffset); // reserved
      const headerSize = additionalInfo < 24 ? 1 : 1 + (1 << (additionalInfo - 24));
      if (headerOffset + headerSize > end) return headerOffset + headerSize - end;
      // Integers, simple values and floats are complete with their header;
      // their values are validated by the decoder, not here.
      const carriesLength = majorType > Major.Negative && majorType < Major.Simple;
      if (carriesLength && additionalInfo === Info.EightBytes && readUint32(bytes, headerOffset + 1) > 0x1fffff) {
        return deferToDecoder(scan, headerOffset); // a length beyond 2^53
      }
      scan.position = headerOffset + headerSize;
      if (!atIndefiniteLevel) scan.itemsPending--;
      if (carriesLength) {
        const argument = readArgumentValue(bytes, headerOffset + 1, additionalInfo);
        if (majorType === Major.Bytes || majorType === Major.Text) {
          scan.position += argument; // skip the payload
        } else if (majorType === Major.Array) {
          // Same limit checks, in the same order, as the decoder: the error does
          // not depend on where chunk boundaries fall.
          if (argument > limits.maxArrayLength) fail('array-limit', headerOffset - start, 'Array exceeds maxArrayLength');
          scan.itemsPending += argument;
        } else if (majorType === Major.Map) {
          if (argument > limits.maxMapEntries) fail('map-limit', headerOffset - start, 'Map exceeds maxMapEntries');
          scan.itemsPending += 2 * argument;
        } else { // Major.Tag
          scan.itemsPending += 1; // its content
        }
      }
    }
    // Every pending item, and every open item's break, needs at least one more byte.
    if (scan.position - start + scan.itemsPending + scan.openIndefinite.length > maxItemBytes) {
      fail('item-limit', 0, 'Item exceeds maxItemBytes');
    }
  }
  return scan.position > end ? scan.position - end : 0;
}

// ---------------------------------------------------------------- decoding

export function createSequenceDecoder(options: SequenceDecodeOptions = {}): SequenceDecoder {
  const maxItemBytes = options.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
  if (!Number.isSafeInteger(maxItemBytes) || maxItemBytes < 1) fail('item-limit', 0, 'Invalid maxItemBytes');
  const limits = containerLimits(options, 0);

  let streamOffset = 0;              // bytes pushed before the current chunk
  let failure: unknown;              // after an error the decoder stays failed
  let ended = false;
  let busy = false;
  // An item spanning chunks is collected here. A new buffer per spanning
  // item, so values borrowing from it stay valid.
  let assembly: Uint8Array | undefined;
  let filled = 0;
  let itemOffset = 0;                // stream offset where the spanning item starts
  const scan: ScanState = { position: 0, itemsPending: 0, openIndefinite: [] };

  function append(chunk: Uint8Array, start: number, end: number): void {
    const needed = filled + end - start;
    if (assembly === undefined || needed > assembly.length) {
      const larger = new Uint8Array(Math.max(needed, 2 * (assembly?.length ?? 0), ASSEMBLY_BLOCK));
      if (assembly !== undefined) larger.set(assembly.subarray(0, filled));
      assembly = larger;
    }
    assembly.set(chunk.subarray(start, end), filled);
    filled = needed;
  }

  /** Start assembling an item that runs past the end of the chunk. */
  function beginSpanning(chunk: Uint8Array, start: number): void {
    assembly = undefined;
    filled = 0;
    itemOffset = streamOffset + start;
    resetScan(scan, 0);
    append(chunk, start, chunk.length);
  }

  /** Feed the spanning item from `chunk`. Returns where in the chunk normal
   * decoding resumes (negative if the item ended in bytes appended earlier),
   * or chunk.length if the item is still incomplete. */
  function continueSpanning(chunk: Uint8Array, onValue: (value: Value) => void): number {
    let taken = 0;
    for (;;) {
      let needed: number;
      let value: Value | undefined;
      try {
        needed = scanItem(assembly!, 0, filled, scan, maxItemBytes, limits);
        if (needed === 0) value = readWhole(binary(assembly!.subarray(0, scan.position)), options);
      } catch (error) {
        throw atStreamOffset(error, itemOffset);
      }
      if (needed === 0) {
        const itemEnd = scan.position;
        const resumeAt = taken - (filled - itemEnd); // bytes past the item came from this chunk
        assembly = undefined;
        filled = 0;
        onValue(value!);
        return resumeAt;
      }
      if (taken === chunk.length) return chunk.length;
      const block = Math.min(chunk.length - taken, Math.max(needed, ASSEMBLY_BLOCK));
      append(chunk, taken, taken + block);
      taken += block;
    }
  }

  /** Decode items in place from the chunk. Only the last item can be cut off
   * by the chunk's end; it then moves to the spanning path. */
  function decodeInChunk(chunk: Uint8Array, offset: number, onValue: (value: Value) => void): void {
    const buffer = binary(chunk);
    while (offset < chunk.length) {
      if (chunk.length - offset < SCAN_AHEAD_BYTES) {
        resetScan(scan, offset);
        let needed: number;
        try {
          needed = scanItem(chunk, offset, chunk.length, scan, maxItemBytes, limits);
        } catch (error) {
          throw atStreamOffset(error, streamOffset + offset);
        }
        if (needed > 0) {
          beginSpanning(chunk, offset);
          return;
        }
      }
      let value: Value;
      let next: number;
      try {
        [value, next] = read(buffer, offset, options);
      } catch (error) {
        if (!(error instanceof CborError && error.code === 'truncated')) throw atStreamOffset(error, streamOffset);
        // Probably cut off by the chunk's end. The scan settles it: either more
        // bytes are needed, or the item is complete (and decoding it reports
        // its real error, or it decodes and we carry on after it).
        beginSpanning(chunk, offset);
        const resumeAt = continueSpanning(NO_BYTES, onValue);
        if (assembly !== undefined) return;
        offset = chunk.length + resumeAt;
        continue;
      }
      if (next - offset > maxItemBytes) fail('item-limit', streamOffset + offset, 'Item exceeds maxItemBytes');
      offset = next;
      onValue(value);
    }
  }

  return {
    push(chunk, onValue) {
      if (failure !== undefined) throw failure;
      if (ended) throw new TypeError('push() after end()');
      if (busy) throw new TypeError('push() called from inside onValue');
      binary(chunk); // validates the chunk type
      busy = true;
      try {
        const start = assembly !== undefined ? continueSpanning(chunk, onValue) : 0;
        if (assembly === undefined) decodeInChunk(chunk, start, onValue);
        streamOffset += chunk.length;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        busy = false;
      }
    },
    end() {
      if (failure !== undefined) throw failure;
      ended = true;
      if (assembly !== undefined) {
        failure = new CborError('truncated', itemOffset, 'Stream ended inside a CBOR item');
        throw failure;
      }
    },
    get bufferedBytes() { return assembly === undefined ? 0 : filled; },
    get offset() { return streamOffset; },
  };
}

// ---------------------------------------------------------------- encoding

export interface SequenceEncodeOptions extends EncodeOptions {
  /** 0 (default): one owned chunk per value, for the lowest latency.
   * N > 0: values are written straight into chunks, and a chunk is emitted
   * once it holds at least N bytes, so chunks hold N to N + one value bytes. */
  readonly chunkBytes?: number;
}

export interface SequenceEncoder {
  push(value: Value, onChunk: (chunk: Uint8Array) => void): void;
  /** Emit any partially filled chunk. */
  flush(onChunk: (chunk: Uint8Array) => void): void;
}

export function createSequenceEncoder(options: SequenceEncodeOptions = {}): SequenceEncoder {
  const chunkBytes = options.chunkBytes ?? 0;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 0) throw new RangeError('Invalid chunkBytes');
  if (chunkBytes === 0) {
    return { push: (value, onChunk) => onChunk(encode(value, options)), flush: () => {} };
  }
  // Each emitted chunk is a fresh buffer that is never written again. It starts
  // at up to 64 KiB and grows as values arrive, so a large chunkBytes does not
  // allocate its full size up front.
  const initialBytes = Math.min(chunkBytes, 65536);
  const writeValue = writerFor(profileOf(options));
  let writer: Writer = createWriter(new Uint8Array(initialBytes), 0, true);
  const emit = (onChunk: (chunk: Uint8Array) => void): void => {
    const chunk = writer.bytes.subarray(0, writer.position);
    writer = createWriter(new Uint8Array(initialBytes), 0, true);
    onChunk(chunk);
  };
  return {
    push(value, onChunk) {
      const start = writer.position;
      try {
        writeValue(writer, value, 0);
      } catch (error) {
        writer.position = start; // an unsupported value leaves no partial bytes
        throw error;
      }
      if (writer.position >= chunkBytes) emit(onChunk);
    },
    flush(onChunk) {
      if (writer.position > 0) emit(onChunk);
    },
  };
}
