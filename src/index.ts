import { binary } from './binary.js';
import { readWhole, write as writeAt, encodedSize as measureExact, maxEncodedSize as measureUpper } from './codec.js';
import { profileOf } from './writer.js';
import { CborError } from './error.js';
import type { Result } from './error.js';
import type { Value, DecodeOptions, EncodeOptions, TagHandling } from './types.js';
import type { Binary } from './binary.js';

export { binary } from './binary.js';
export type { Binary } from './binary.js';
export { read, readWhole } from './codec.js';
export { tagged, isTagged } from './tag.js';
export { simple, isSimpleValue } from './simple.js';
export { encode, createSlabEncoder } from './allocation.js';
export type { SlabOptions } from './allocation.js';
export { createSequenceDecoder, createSequenceEncoder } from './sequence.js';
export type { SequenceDecoder, SequenceEncoder, SequenceDecodeOptions, SequenceEncodeOptions } from './sequence.js';
export { decodeStream, encodeStream, decodeSequence, encodeSequence } from './stream.js';
export type { DecodeStreamOptions, EncodeStreamOptions, BatchDecodeStreamOptions, BatchEncodeStreamOptions } from './stream.js';
export { CborError } from './error.js';
export type { ErrorCode, Result } from './error.js';
export type {
  Value, ValueObject, LabelMap, Scalar, TypedArray, Tagged, SimpleValue, TagDecoder, TagHandling, DecodeOptions,
  EncodeOptions, Decoded,
} from './types.js';

/** RFC 8746 typed arrays (tags 64–87) and self-described CBOR (55799). */
const strictTags: Readonly<Record<number, TagHandling>> = Object.freeze({
  ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [64 + index, 'tagged' as const])),
  55799: 'reject' as const,
});

/** Strict decoding, as security formats (COSE, CWT, WebAuthn, mdoc) need:
 * every map is a Map with integer or text keys, duplicate keys and invalid
 * UTF-8 are errors, tags with no built-in meaning are errors, typed-array
 * tags stay tags (so one can't pass for a byte string), and self-described
 * CBOR is rejected. Frozen; spread it to change a field. */
export const STRICT_DECODE: DecodeOptions = Object.freeze({
  maps: 'map',
  mapKeys: 'integer-or-text',
  duplicateKeys: 'reject',
  invalidUtf8: 'reject',
  unknownTags: 'reject',
  tags: strictTags,
});

/** Write into a prepared buffer; returns the next offset. */
export function write(buffer: Binary, offset: number, value: Value, options?: EncodeOptions): number {
  return writeAt(buffer, offset, value, profileOf(options));
}

export function encodeInto(value: Value, destination: Uint8Array, offset = 0, options?: EncodeOptions): number {
  return writeAt(binary(destination), offset, value, profileOf(options));
}

/** Exact encoded size. */
export function encodedSize(value: Value, options?: EncodeOptions): number {
  return measureExact(value, profileOf(options));
}

/** Upper bound on the encoded size, without scanning strings. */
export function maxEncodedSize(value: Value, options?: EncodeOptions): number {
  return measureUpper(value, profileOf(options));
}

export function decode(bytes: Uint8Array, options?: DecodeOptions): Value {
  return readWhole(binary(bytes), options);
}

export function tryDecode(bytes: Uint8Array, options?: DecodeOptions): Result<Value> {
  try {
    return { ok: true, value: decode(bytes, options) };
  } catch (error) {
    if (error instanceof CborError) return { ok: false, error };
    throw error;
  }
}
