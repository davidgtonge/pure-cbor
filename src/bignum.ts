import { writable } from './binary.js';
import { argumentSize, writeArgument, writeUint32, Info, MajorBits } from './header.js';
import { fail } from './error.js';

// bigint <-> CBOR: within the 64-bit argument range as major type 0/1
// integers (the same wire form as numbers); beyond it as RFC 8949 bignums,
// tag 2 (positive) or tag 3 (negative), whose content is the big-endian
// magnitude as a byte string.

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const TWO_POW_64 = 1n << 64n;
const MASK_32 = 0xffffffffn;
const POSITIVE_BIGNUM_HEADER = MajorBits.Tag | 2;
const NEGATIVE_BIGNUM_HEADER = MajorBits.Tag | 3;

/** CBOR's argument for a bigint: n for n >= 0, -1 - n for negatives. */
const argumentOf = (value: bigint): bigint => (value < 0n ? -1n - value : value);

function magnitudeBytes(magnitude: bigint): Uint8Array {
  let hex = magnitude.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(hex.slice(2 * index, 2 * index + 2), 16);
  return bytes;
}

export function size(value: bigint): number {
  const argument = argumentOf(value);
  if (argument <= MAX_SAFE) return argumentSize(Number(argument));
  if (argument < TWO_POW_64) return 9;
  const byteLength = magnitudeBytes(argument).length;
  return 1 + argumentSize(byteLength) + byteLength;
}

export function write(bytes: Uint8Array, offset: number, value: bigint): number {
  const negative = value < 0n;
  const argument = argumentOf(value);
  const majorBits = negative ? MajorBits.Negative : MajorBits.Unsigned;
  writable(bytes, offset, size(value));
  if (argument <= MAX_SAFE) return writeArgument(bytes, offset, majorBits, Number(argument));
  if (argument < TWO_POW_64) {
    bytes[offset] = majorBits | Info.EightBytes;
    writeUint32(bytes, offset + 1, Number(argument >> 32n));
    writeUint32(bytes, offset + 5, Number(argument & MASK_32));
    return offset + 9;
  }
  const magnitude = magnitudeBytes(argument);
  bytes[offset] = negative ? NEGATIVE_BIGNUM_HEADER : POSITIVE_BIGNUM_HEADER;
  const payloadStart = writeArgument(bytes, offset + 1, MajorBits.Bytes, magnitude.length);
  bytes.set(magnitude, payloadStart);
  return payloadStart + magnitude.length;
}

/** Tag 2/3 content (a byte string) to a bigint. */
export function fromBignum(content: unknown, negative: boolean, offset: number): bigint {
  if (!(content instanceof Uint8Array)) fail('invalid-tag-content', offset, 'Bignum content must be a byte string');
  let hex = '';
  for (let index = 0; index < content.length; index++) hex += content[index].toString(16).padStart(2, '0');
  const magnitude = hex === '' ? 0n : BigInt(`0x${hex}`);
  return negative ? -1n - magnitude : magnitude;
}
