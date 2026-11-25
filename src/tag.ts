import { fail } from './error.js';
import * as Bignum from './bignum.js';
import type { DecodeOptions, Tagged, Value } from './types.js';

// Tags: an immutable Tagged variant, built-in conversions on decode, and
// Date <-> tag 1 on encode. RFC 8746 typed-array tags live in typed-array.ts.

const TaggedPrototype: object = Object.freeze(Object.create(Object.prototype, {
  [Symbol.toStringTag]: { value: 'Tagged' },
}));

/** An immutable tagged value. Tag numbers are safe integers. */
export function tagged(tag: number, value: Value): Tagged {
  if (!Number.isSafeInteger(tag) || tag < 0) throw new RangeError('Tag numbers are non-negative safe integers');
  const result = Object.create(TaggedPrototype) as { tag: number; value: Value };
  result.tag = tag;
  result.value = value;
  return Object.freeze(result);
}

export function isTagged(value: unknown): value is Tagged {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === TaggedPrototype;
}

export const DATE_TIME = 0;
export const EPOCH_TIME = 1;
export const POSITIVE_BIGNUM = 2;
export const NEGATIVE_BIGNUM = 3;
export const SELF_DESCRIBED = 55799;

// ---------------------------------------------------------------- dates

/** A Date as tag 1 content: seconds since the epoch, integral when possible. */
export function epochSeconds(date: Date): number {
  const milliseconds = date.getTime();
  if (Number.isNaN(milliseconds)) fail('unsupported-type', 0, 'Invalid Date');
  return milliseconds / 1000;
}

/** Bytes of the tag-1 header. */
export const EPOCH_TIME_HEADER = 0xc1;

function dateFromText(content: Value, offset: number): Date {
  if (typeof content !== 'string') fail('invalid-tag-content', offset, 'Tag 0 content must be a date/time string');
  const milliseconds = Date.parse(content);
  if (Number.isNaN(milliseconds)) fail('invalid-tag-content', offset, 'Tag 0 content is not a valid date/time');
  return new Date(milliseconds);
}

function dateFromEpoch(content: Value, offset: number): Date {
  if (typeof content !== 'number' || !Number.isFinite(content)) {
    fail('invalid-tag-content', offset, 'Tag 1 content must be a finite number');
  }
  // Date holds whole milliseconds; rounding undoes float error from the
  // seconds conversion (so encode -> decode returns the same Date).
  return new Date(Math.round(content * 1000));
}

// ---------------------------------------------------------------- decoding

/** Convert decoded tag content: a caller's decoder first, then the built-ins,
 * otherwise a Tagged value (or an error with unknownTags: 'reject'). */
export function decodeTag(tag: number, content: Value, options: DecodeOptions | undefined, offset: number): Value {
  const custom = options?.tags;
  if (custom !== undefined && Object.hasOwn(custom, tag)) return custom[tag](content);
  switch (tag) {
    case DATE_TIME: return dateFromText(content, offset);
    case EPOCH_TIME: return dateFromEpoch(content, offset);
    case POSITIVE_BIGNUM: return Bignum.fromBignum(content, false, offset);
    case NEGATIVE_BIGNUM: return Bignum.fromBignum(content, true, offset);
    case SELF_DESCRIBED: return content;
  }
  if (options?.unknownTags === 'reject') fail('unsupported-tag', offset, `Unsupported CBOR tag ${tag}`);
  return tagged(tag, content);
}

/** Whether the caller supplied a decoder for this tag. */
export function hasCustomDecoder(options: DecodeOptions | undefined, tag: number): boolean {
  const custom = options?.tags;
  return custom !== undefined && Object.hasOwn(custom, tag);
}
