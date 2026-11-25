export type TypedArray =
  | Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | BigUint64Array
  | Int8Array | Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array;

/** A CBOR tag the decoder has no conversion for, or one built with `tagged()`.
 * An immutable variant: recognized by its prototype, not its shape. */
export interface Tagged {
  readonly tag: number;
  readonly value: Value;
}

/** A CBOR simple value other than false, true, null and undefined (0–19 and
 * 32–255), built with `simple()`. */
export interface SimpleValue {
  readonly simple: number;
}

export type Scalar = number | bigint | string | boolean | null | undefined;

/** Every value this library encodes and decodes. Maps decode to plain objects
 * when all keys are text (by default), otherwise to `Map`. */
export type Value =
  | Scalar | TypedArray | Date | Tagged | SimpleValue
  | readonly Value[] | ReadonlyMap<Value, Value> | ValueObject;

/** A plain object (prototype Object.prototype or null) with string keys.
 * Properties whose value is undefined are omitted on encode, as in JSON. */
export interface ValueObject { readonly [key: string]: Value }

export type Decoded<T = Value> = readonly [value: T, nextOffset: number];

/** Decodes the content of one CBOR tag. */
export type TagDecoder = (content: Value) => Value;

export interface DecodeOptions {
  /** How byte strings and typed arrays relate to the input:
   * 'copy' (default): copied, so independent of the input; byte strings over
   *   64 bytes from one decode may share one backing buffer (an arena).
   * 'copy-separate': each copied into its own exactly sized buffer.
   * 'borrow': views into the input where possible (aligned, native-endian);
   *   fastest, valid while the input is unchanged. */
  readonly binaryOwnership?: 'copy' | 'copy-separate' | 'borrow';
  /** Reject invalid UTF-8 by default; optionally replace invalid sequences. */
  readonly invalidUtf8?: 'reject' | 'replace';
  /** Maximum elements per array, checked before allocating. Default: 1,000,000. */
  readonly maxArrayLength?: number;
  /** Maximum entries per map, checked before decoding entries. Default: 1,000,000. */
  readonly maxMapEntries?: number;
  /** Maximum nesting of arrays, maps and tags. Default: 128. */
  readonly maxDepth?: number;
  /** Duplicate map keys are invalid CBOR. Default 'reject'; 'last-wins' keeps the last value. */
  readonly duplicateKeys?: 'reject' | 'last-wins';
  /** 'auto' (default): plain objects when every key is text, otherwise Map.
   * 'object': text keys only (others are an error). 'map': always Map. */
  readonly maps?: 'auto' | 'object' | 'map';
  /** Decoders by tag number; they take precedence over the built-in ones
   * (0, 1: Date; 2, 3: bigint; 55799: unwrapped; RFC 8746 typed arrays). */
  readonly tags?: Readonly<Record<number, TagDecoder>>;
  /** Tags with no decoder: 'tagged' (default) returns a Tagged value; 'reject' is an error. */
  readonly unknownTags?: 'tagged' | 'reject';
}

export interface EncodeOptions {
  /** 'float64' (default, fastest) or 'shortest': the smallest of binary16,
   * binary32 and binary64 that holds the value exactly (RFC 8949 §4.1). */
  readonly floats?: 'float64' | 'shortest';
  /** Core deterministic encoding (RFC 8949 §4.2.1): shortest floats and map
   * keys sorted by their encoded bytes. Output is canonical, for hashing or
   * signing. Slower; off by default. */
  readonly deterministic?: boolean;
}
