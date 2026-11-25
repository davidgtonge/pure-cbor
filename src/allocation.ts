import { arrayKind } from './binary.js';
import { maxEncodedSize, writeBytes, writerFor } from './codec.js';
import * as NumberCodec from './number.js';
import * as StringCodec from './string.js';
import * as TypedArrayCodec from './typed-array.js';
import * as Simple from './simple.js';
import { createWriter, DEFAULT_PROFILE, profileOf } from './writer.js';
import type { EncodeProfile } from './writer.js';
import type { EncodeOptions, TypedArray, Value } from './types.js';

/** Staging memory for owned text and container output: one growable pass,
 * then the used bytes are copied out once. One output allocation and no
 * sizing pass. (In V8 any typed array over 64 bytes is a separate off-heap
 * allocation costing ~0.5 µs, so allocation count dominates.) It holds no data
 * between calls; a reentrant call, possible only through exotic inputs such
 * as accessor properties, uses a private buffer instead. */
const STAGING_LIMIT = 64 * 1024;
let staging: Uint8Array = new Uint8Array(0);
let stagingInUse = false;

/** Encode into staging memory and hand the used bytes to `take`, which must
 * copy what it needs before returning. */
function staged<R>(value: Value, profile: EncodeProfile, take: (bytes: Uint8Array, end: number) => R): R {
  if (stagingInUse) {
    const writer = createWriter(new Uint8Array(256), 0, true);
    writerFor(profile)(writer, value, 0);
    return take(writer.bytes, writer.position);
  }
  stagingInUse = true;
  try {
    const writer = createWriter(staging, 0, true);
    writerFor(profile)(writer, value, 0);
    if (writer.bytes.length <= STAGING_LIMIT) staging = writer.bytes;
    return take(writer.bytes, writer.position);
  } finally {
    stagingInUse = false;
  }
}

const copyOut = (bytes: Uint8Array, end: number): Uint8Array => bytes.slice(0, end);

/** Exact-sized, independently owned output. Small outputs never touch a
 * `.buffer`, so they stay cheap V8 on-heap allocations. */
export function encode(value: Value, options?: EncodeOptions): Uint8Array {
  // Options take a separate path; the default below is unchanged by them.
  if (options !== undefined) return encodeWithOptions(value, profileOf(options));
  if (typeof value === 'number') {
    const bytes = new Uint8Array(NumberCodec.size(value));
    NumberCodec.write(bytes, 0, value);
    return bytes;
  }
  if (Simple.isSimple(value)) {
    const bytes = new Uint8Array(1);
    bytes[0] = Simple.tokenOf(value);
    return bytes;
  }
  if (typeof value === 'string') {
    // Direct into staging: the most common owned value needs no writer.
    const capacity = StringCodec.maxSize(value);
    if (capacity > STAGING_LIMIT || stagingInUse) return StringCodec.encodeOwned(value);
    if (staging.length < capacity) staging = new Uint8Array(Math.max(capacity, 2 * staging.length, 256));
    return staging.slice(0, StringCodec.write(staging, 0, value));
  }
  if (arrayKind(value) !== undefined) {
    const bytes = new Uint8Array(TypedArrayCodec.size(value as TypedArray));
    TypedArrayCodec.write(bytes, 0, value as TypedArray);
    return bytes;
  }
  return staged(value, DEFAULT_PROFILE, copyOut);
}

function encodeWithOptions(value: Value, profile: EncodeProfile): Uint8Array {
  if (typeof value === 'number' && profile.shortestFloats) {
    const bytes = new Uint8Array(NumberCodec.sizeShortest(value));
    NumberCodec.writeShortest(bytes, 0, value);
    return bytes;
  }
  if (profile === DEFAULT_PROFILE || typeof value !== 'object' || value === null || arrayKind(value) !== undefined) {
    return encode(value); // options only affect floats and containers
  }
  return staged(value, profile, copyOut);
}

export interface SlabOptions extends EncodeOptions {
  /** Bytes in a slab. Default 64 KiB. */
  readonly slabSize?: number;
  /** Largest encoded size eligible for pooling. Default one quarter of slabSize. */
  readonly maxPooledValueSize?: number;
}

/** An explicit allocation policy. The closure owns at most one current slab.
 * Previously returned views stay valid and never overlap subsequent writes.
 * Large items bypass the pool. Callers must not transfer/detach or modify the
 * entire backing buffer; mutating their own returned slice is allowed. */
export function createSlabEncoder(options: SlabOptions = {}): (value: Value) => Uint8Array {
  const slabSize = options.slabSize ?? 65536;
  const threshold = options.maxPooledValueSize ?? Math.max(1, Math.floor(slabSize / 4));
  if (!Number.isSafeInteger(slabSize) || slabSize < 1 || slabSize > 0x7fffffff ||
      !Number.isSafeInteger(threshold) || threshold < 0 || threshold > slabSize) {
    throw new RangeError('Invalid slab size or maxPooledValueSize');
  }
  const profile = profileOf(options);
  let slab: Uint8Array | undefined;
  let cursor = 0;
  let busy = false;

  const pool = (bytes: Uint8Array, end: number): Uint8Array => {
    if (end > threshold) return bytes.slice(0, end);
    if (!slab || end > slab.length - cursor) {
      slab = new Uint8Array(slabSize);
      cursor = 0;
    }
    slab.set(bytes.subarray(0, end), cursor);
    cursor += end;
    return slab.subarray(cursor - end, cursor);
  };

  return (value: Value): Uint8Array => {
    // Reentrant calls never touch an active slab, even if an exotic input runs code.
    if (busy) return encode(value, options);
    busy = true;
    try {
      const container = typeof value === 'object' && value !== null && arrayKind(value) === undefined;
      if (container) return staged(value, profile, pool);
      // Scalars and typed arrays have O(1) size bounds: write straight into the slab.
      const capacity = maxEncodedSize(value, profile);
      if (capacity > threshold) return encode(value, options);
      if (!slab || capacity > slab.length - cursor) {
        slab = new Uint8Array(slabSize);
        cursor = 0;
      }
      const start = cursor;
      cursor = writeBytes(slab, start, value, profile);
      return slab.subarray(start, cursor);
    } finally {
      busy = false;
    }
  };
}
