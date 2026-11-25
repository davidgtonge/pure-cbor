import { readable, writable } from './binary.js';
import { fail } from './error.js';
import { Info, MajorBits } from './header.js';
import * as NumberCodec from './number.js';
import type { SimpleValue } from './types.js';

// Major type 7: simple values and floats.
//   false, true, null, undefined  -> tokens f4..f7, one byte each
//   other simple values 0..19     -> e0..f3        (SimpleValue)
//   other simple values 32..255   -> f8 nn         (SimpleValue)
//   binary16/32/64                -> f9, fa, fb    (numbers)
//   f8 with nn < 32 is not well-formed; 28..30 are reserved; ff is "break".

export type Simple = boolean | null | undefined;

export const FALSE = 0xf4;
export const TRUE = 0xf5;
export const NULL = 0xf6;
export const UNDEFINED = 0xf7;

export function isSimple(value: unknown): value is Simple {
  return value === null || value === undefined || typeof value === 'boolean';
}

export function isToken(token: number): boolean {
  return token >= FALSE && token <= UNDEFINED;
}

export function tokenOf(value: Simple): number {
  return value === null ? NULL : value === undefined ? UNDEFINED : value ? TRUE : FALSE;
}

/** token must satisfy isToken. */
export function valueOf(token: number): Simple {
  return token === NULL ? null : token === UNDEFINED ? undefined : token === TRUE;
}

export function write(bytes: Uint8Array, offset: number, value: Simple): number {
  writable(bytes, offset, 1);
  bytes[offset] = tokenOf(value);
  return offset + 1;
}

// ---------------------------------------------------------------- SimpleValue

const SimpleValuePrototype: object = Object.freeze(Object.create(Object.prototype, {
  [Symbol.toStringTag]: { value: 'SimpleValue' },
}));

/** An immutable simple value: 0–19 or 32–255 (20–23 are false, true, null
 * and undefined; 24–31 are not simple values). */
export function simple(value: number): SimpleValue {
  if (!Number.isInteger(value) || value < 0 || value > 255 || (value >= 20 && value <= 31)) {
    throw new RangeError('Simple values are 0-19 or 32-255');
  }
  const result = Object.create(SimpleValuePrototype) as { simple: number };
  result.simple = value;
  return Object.freeze(result);
}

export function isSimpleValue(value: unknown): value is SimpleValue {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === SimpleValuePrototype;
}

export function simpleSize(value: SimpleValue): number {
  return value.simple < 24 ? 1 : 2;
}

export function writeSimpleValue(bytes: Uint8Array, offset: number, value: SimpleValue): number {
  const size = simpleSize(value);
  writable(bytes, offset, size);
  if (size === 1) {
    bytes[offset] = MajorBits.Simple | value.simple;
  } else {
    bytes[offset] = MajorBits.Simple | Info.OneByte;
    bytes[offset + 1] = value.simple;
  }
  return offset + size;
}

/** Any major-type-7 item. token is the already-read initial byte; offset is
 * just after it. The caller advances by argumentEnd(offset, token & 31). */
export function readMajor7(bytes: Uint8Array, offset: number, token: number): number | Simple | SimpleValue {
  const additionalInfo = token & 31;
  if (additionalInfo >= 25 && additionalInfo <= 27) return NumberCodec.readFloat(bytes, offset, additionalInfo);
  if (additionalInfo < 20) return simple(additionalInfo);
  if (additionalInfo < 24) return valueOf(token);
  if (additionalInfo === Info.OneByte) {
    readable(bytes, offset, 1);
    if (bytes[offset] < 32) fail('invalid-header', offset - 1, 'Simple values below 32 must use the one-byte form');
    return simple(bytes[offset]);
  }
  if (additionalInfo === Info.Indefinite) fail('invalid-header', offset - 1, 'Unexpected break code');
  return fail('invalid-header', offset - 1, 'Reserved simple value encoding');
}
