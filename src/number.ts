import { LITTLE_ENDIAN, readable, writable } from './binary.js';
import { argumentSize, readArgumentValue, readUint32, writeArgument, Major } from './header.js';
import { fail } from './error.js';

// Float conversion scratch, used synchronously within one call (no user code
// runs in between), so it carries no state across operations. It replaces
// DataView, whose construction is expensive on fresh small buffers.
const float64 = new Float64Array(1);
const float64Bytes = new Uint8Array(float64.buffer);
const float32 = new Float32Array(1);
const float32Bytes = new Uint8Array(float32.buffer);
const float32Bits = new Uint32Array(float32.buffer);

/** Floats share major type 7 with simple values. */
const FLOAT = Major.Simple;

/** Every safe integer is a CBOR integer in its preferred width, so other
 * languages receive integer types (e.g. millisecond timestamps). Everything
 * else (fractions, -0, NaN, infinities, unsafe integers) is binary64. */
function majorTypeOf(value: number): Major.Unsigned | Major.Negative | Major.Simple {
  if ((value >>> 0) === value) return Object.is(value, -0) ? FLOAT : Major.Unsigned;
  if (Number.isSafeInteger(value)) return value < 0 ? Major.Negative : Major.Unsigned;
  return FLOAT;
}

export function size(value: number): number {
  const majorType = majorTypeOf(value);
  if (majorType === FLOAT) return 9;
  return argumentSize(majorType === Major.Unsigned ? value : -1 - value);
}

/** Size with floats in their shortest exact form (see writeShortest). */
export function sizeShortest(value: number): number {
  return majorTypeOf(value) === FLOAT ? shortestFloatSize(value) : size(value);
}

// ---------------------------------------------------------------- shortest floats

/** The binary16 bit pattern holding `value` exactly, or -1. `value` must
 * already be exact in binary32 (and not NaN). */
function float16Bits(value: number): number {
  float32[0] = value;
  const bits = float32Bits[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00;          // infinity
  if (exponent === 0) return mantissa === 0 ? sign : -1; // zero; binary32 subnormals are too small
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 31) return -1;                     // too large
  if (halfExponent >= 1) {                               // normal binary16
    return (mantissa & 0x1fff) === 0 ? sign | (halfExponent << 10) | (mantissa >>> 13) : -1;
  }
  const significand = 0x800000 | mantissa;               // subnormal binary16
  const shift = 126 - exponent;
  if (shift > 24 || (significand & ((1 << shift) - 1)) !== 0) return -1;
  return sign | (significand >>> shift);
}

function isFloat32(value: number): boolean {
  return Math.fround(value) === value;
}

function shortestFloatSize(value: number): number {
  if (Number.isNaN(value)) return 3;
  if (!isFloat32(value)) return 9;
  return float16Bits(value) !== -1 ? 3 : 5;
}

/** RFC 8949 §4.1 preferred float: binary16, binary32 or binary64, whichever
 * is the smallest exact form. NaN is the canonical f97e00. */
function writeShortestFloat(bytes: Uint8Array, offset: number, value: number): number {
  if (Number.isNaN(value)) {
    bytes[offset] = 0xf9;
    bytes[offset + 1] = 0x7e;
    bytes[offset + 2] = 0x00;
    return offset + 3;
  }
  if (!isFloat32(value)) return writeFloat64(bytes, offset, value);
  const half = float16Bits(value);
  if (half !== -1) {
    bytes[offset] = 0xf9;
    bytes[offset + 1] = half >>> 8;
    bytes[offset + 2] = half & 0xff;
    return offset + 3;
  }
  float32[0] = value;
  const source = float32Bytes;
  bytes[offset] = 0xfa;
  if (LITTLE_ENDIAN) {
    bytes[offset + 1] = source[3]; bytes[offset + 2] = source[2]; bytes[offset + 3] = source[1]; bytes[offset + 4] = source[0];
  } else {
    bytes[offset + 1] = source[0]; bytes[offset + 2] = source[1]; bytes[offset + 3] = source[2]; bytes[offset + 4] = source[3];
  }
  return offset + 5;
}

// Unrolled: a byte loop here was ~1.6x slower in array benchmarks.
function writeFloat64(bytes: Uint8Array, offset: number, value: number): number {
  float64[0] = value;
  const source = float64Bytes;
  bytes[offset] = 0xfb;
  if (LITTLE_ENDIAN) {
    bytes[offset + 1] = source[7]; bytes[offset + 2] = source[6]; bytes[offset + 3] = source[5]; bytes[offset + 4] = source[4];
    bytes[offset + 5] = source[3]; bytes[offset + 6] = source[2]; bytes[offset + 7] = source[1]; bytes[offset + 8] = source[0];
  } else {
    bytes[offset + 1] = source[0]; bytes[offset + 2] = source[1]; bytes[offset + 3] = source[2]; bytes[offset + 4] = source[3];
    bytes[offset + 5] = source[4]; bytes[offset + 6] = source[5]; bytes[offset + 7] = source[6]; bytes[offset + 8] = source[7];
  }
  return offset + 9;
}

/** The default: integers in their preferred width, everything else binary64. */
export function write(bytes: Uint8Array, offset: number, value: number): number {
  const majorType = majorTypeOf(value);
  if (majorType === FLOAT) {
    writable(bytes, offset, 9);
    return writeFloat64(bytes, offset, value);
  }
  const argument = majorType === Major.Unsigned ? value : -1 - value;
  writable(bytes, offset, argumentSize(argument));
  return writeArgument(bytes, offset, majorType << 5, argument);
}

/** Like write, but floats in their shortest exact form (RFC 8949 §4.1). A
 * separate function, so the default write stays small enough for V8 to inline
 * into the array and object loops (an unused option branch cost ~5%). */
export function writeShortest(bytes: Uint8Array, offset: number, value: number): number {
  if (majorTypeOf(value) !== FLOAT) return write(bytes, offset, value);
  writable(bytes, offset, shortestFloatSize(value));
  return writeShortestFloat(bytes, offset, value);
}

function float16(bits: number): number {
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  const sign = (bits & 0x8000) ? -1 : 1;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  return sign * (1024 + fraction) * 2 ** (exponent - 25);
}

/** Big-endian binary64 at offset; caller has checked 8 readable bytes. */
export function readFloat64(bytes: Uint8Array, offset: number): number {
  const target = float64Bytes;
  if (LITTLE_ENDIAN) {
    target[0] = bytes[offset + 7]; target[1] = bytes[offset + 6]; target[2] = bytes[offset + 5]; target[3] = bytes[offset + 4];
    target[4] = bytes[offset + 3]; target[5] = bytes[offset + 2]; target[6] = bytes[offset + 1]; target[7] = bytes[offset];
  } else {
    target[0] = bytes[offset]; target[1] = bytes[offset + 1]; target[2] = bytes[offset + 2]; target[3] = bytes[offset + 3];
    target[4] = bytes[offset + 4]; target[5] = bytes[offset + 5]; target[6] = bytes[offset + 6]; target[7] = bytes[offset + 7];
  }
  return float64[0];
}

function readFloat32(bytes: Uint8Array, offset: number): number {
  const target = float32Bytes;
  if (LITTLE_ENDIAN) {
    target[0] = bytes[offset + 3]; target[1] = bytes[offset + 2]; target[2] = bytes[offset + 1]; target[3] = bytes[offset];
  } else {
    target[0] = bytes[offset]; target[1] = bytes[offset + 1]; target[2] = bytes[offset + 2]; target[3] = bytes[offset + 3];
  }
  return float32[0];
}

/** A 64-bit integer argument (additional info 27): a number when safe,
 * otherwise a bigint. */
function readInteger64(bytes: Uint8Array, offset: number, negative: boolean): number | bigint {
  readable(bytes, offset, 8);
  const high = readUint32(bytes, offset);
  const low = readUint32(bytes, offset + 4);
  if (high <= 0x1fffff) {
    const argument = high * 0x100000000 + low;
    if (!negative) return argument;
    if (argument < Number.MAX_SAFE_INTEGER) return -1 - argument;
  }
  const argument = (BigInt(high) << 32n) | BigInt(low);
  return negative ? -1n - argument : argument;
}

/** Integers (major types 0 and 1) and floats. token is the already-read
 * initial byte; offset is just after it. */
export function readValue(bytes: Uint8Array, offset: number, token: number): number | bigint {
  const majorType = token >>> 5;
  const additionalInfo = token & 31;
  if (majorType === Major.Unsigned || majorType === Major.Negative) {
    if (additionalInfo === 27) return readInteger64(bytes, offset, majorType === Major.Negative);
    const argument = additionalInfo < 24 ? additionalInfo : readArgumentValue(bytes, offset, additionalInfo);
    return majorType === Major.Unsigned ? argument : -1 - argument;
  }
  return readFloat(bytes, offset, additionalInfo);
}

/** binary16, binary32 or binary64 by additional info 25, 26 or 27. */
export function readFloat(bytes: Uint8Array, offset: number, additionalInfo: number): number {
  switch (additionalInfo) {
    case 25:
      readable(bytes, offset, 2);
      return float16((bytes[offset] << 8) | bytes[offset + 1]);
    case 26:
      readable(bytes, offset, 4);
      return readFloat32(bytes, offset);
    case 27:
      readable(bytes, offset, 8);
      return readFloat64(bytes, offset);
    default:
      return fail('unsupported-type', offset - 1, 'Not a floating-point value');
  }
}
