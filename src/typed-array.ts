import { arrayKind, LITTLE_ENDIAN, readable, writable } from './binary.js';
import { argumentSize, argumentEnd, readArgumentValue, writeArgument, Info, Major, MajorBits } from './header.js';
import { fail } from './error.js';
import type { DecodeOptions, Decoded, TypedArray } from './types.js';

type TypedArrayConstructor = {
  readonly BYTES_PER_ELEMENT: number;
  new(length: number): TypedArray;
  new(buffer: ArrayBufferLike, byteOffset: number, length: number): TypedArray;
};

type TagDescriptor = Readonly<{ ArrayType: TypedArrayConstructor; littleEndian: boolean }>;

const BYTES_TAG = 64;

// RFC 8746 tags. Undefined entries (float16, float128, etc.) are unsupported.
// Untagged byte strings are also accepted as Uint8Array.
const tags: Readonly<Partial<Record<number, TagDescriptor>>> = {
  64: { ArrayType: Uint8Array, littleEndian: true },
  65: { ArrayType: Uint16Array, littleEndian: false },
  66: { ArrayType: Uint32Array, littleEndian: false },
  67: { ArrayType: BigUint64Array, littleEndian: false },
  68: { ArrayType: Uint8ClampedArray, littleEndian: true },
  69: { ArrayType: Uint16Array, littleEndian: true },
  70: { ArrayType: Uint32Array, littleEndian: true },
  71: { ArrayType: BigUint64Array, littleEndian: true },
  72: { ArrayType: Int8Array, littleEndian: true },
  73: { ArrayType: Int16Array, littleEndian: false },
  74: { ArrayType: Int32Array, littleEndian: false },
  75: { ArrayType: BigInt64Array, littleEndian: false },
  77: { ArrayType: Int16Array, littleEndian: true },
  78: { ArrayType: Int32Array, littleEndian: true },
  79: { ArrayType: BigInt64Array, littleEndian: true },
  81: { ArrayType: Float32Array, littleEndian: false },
  82: { ArrayType: Float64Array, littleEndian: false },
  85: { ArrayType: Float32Array, littleEndian: true },
  86: { ArrayType: Float64Array, littleEndian: true },
};

/** 0 means a plain byte string (Uint8Array), for interoperability. */
function tagOf(value: unknown): number {
  switch (arrayKind(value)) {
    case 'Uint8Array': return 0;
    case 'Uint8ClampedArray': return 68;
    case 'Uint16Array': return LITTLE_ENDIAN ? 69 : 65;
    case 'Uint32Array': return LITTLE_ENDIAN ? 70 : 66;
    case 'BigUint64Array': return LITTLE_ENDIAN ? 71 : 67;
    case 'Int8Array': return 72;
    case 'Int16Array': return LITTLE_ENDIAN ? 77 : 73;
    case 'Int32Array': return LITTLE_ENDIAN ? 78 : 74;
    case 'BigInt64Array': return LITTLE_ENDIAN ? 79 : 75;
    case 'Float32Array': return LITTLE_ENDIAN ? 85 : 81;
    case 'Float64Array': return LITTLE_ENDIAN ? 86 : 82;
    default: fail('unsupported-type', 0, 'Unsupported typed array or value');
  }
}

export function size(value: TypedArray): number {
  const tag = tagOf(value);
  const byteLength = value.byteLength;
  return (tag === 0 ? 0 : 2) + argumentSize(byteLength) + byteLength;
}

/** Overlapping source and destination views are supported: the payload is
 * moved before the header is written. */
export function write(bytes: Uint8Array, offset: number, value: TypedArray): number {
  const tag = tagOf(value);
  const byteLength = value.byteLength;
  const tagSize = tag === 0 ? 0 : 2;
  const payloadStart = offset + tagSize + argumentSize(byteLength);
  writable(bytes, offset, payloadStart - offset + byteLength);
  bytes.set(new Uint8Array(value.buffer, value.byteOffset, byteLength), payloadStart);
  if (tag !== 0) {
    bytes[offset++] = MajorBits.Tag | Info.OneByte; // every typed-array tag is 64–87
    bytes[offset++] = tag;
  }
  writeArgument(bytes, offset, MajorBits.Bytes, byteLength);
  return payloadStart + byteLength;
}

/** A Uint8Array (or Buffer) as a plain byte string, skipping the typed-array
 * kind lookup. Like write(), the payload is moved before the header, so an
 * overlapping source is safe. */
export function writeByteString(bytes: Uint8Array, offset: number, value: Uint8Array): number {
  const byteLength = value.length;
  const payloadStart = offset + argumentSize(byteLength);
  writable(bytes, offset, payloadStart - offset + byteLength);
  bytes.set(value, payloadStart);
  writeArgument(bytes, offset, MajorBits.Bytes, byteLength);
  return payloadStart + byteLength;
}

function materialize(bytes: Uint8Array, start: number, byteLength: number, descriptor: TagDescriptor, options: DecodeOptions | undefined): TypedArray {
  const { ArrayType, littleEndian } = descriptor;
  const width = ArrayType.BYTES_PER_ELEMENT;
  if (byteLength % width !== 0) fail('invalid-length', start, 'Typed array payload is not a multiple of its element width');
  readable(bytes, start, byteLength);
  const absoluteOffset = bytes.byteOffset + start;
  const nativeOrder = width === 1 || littleEndian === LITTLE_ENDIAN;
  if (options?.binaryOwnership === 'borrow' && nativeOrder && absoluteOffset % width === 0) {
    return new ArrayType(bytes.buffer, absoluteOffset, byteLength / width);
  }
  // Plain bytes: slice avoids touching result.buffer (costly on small arrays).
  if (ArrayType === Uint8Array) return bytes.slice(start, start + byteLength);
  // One allocation, no element conversion: even NaN payload bits are preserved.
  const result = new ArrayType(byteLength / width);
  const resultBytes = new Uint8Array(result.buffer, result.byteOffset, byteLength);
  if (nativeOrder) {
    resultBytes.set(bytes.subarray(start, start + byteLength));
  } else {
    // Reverse the bytes within each element (not the element order).
    for (let element = 0; element < byteLength; element += width) {
      for (let index = 0; index < width; index++) {
        resultBytes[element + index] = bytes[start + element + width - 1 - index];
      }
    }
  }
  return result;
}

/** offset is just after the byte string's initial byte. */
export function readBytes(bytes: Uint8Array, offset: number, additionalInfo: number, options: DecodeOptions | undefined): Decoded<TypedArray> {
  const byteLength = readArgumentValue(bytes, offset, additionalInfo);
  const payloadStart = argumentEnd(offset, additionalInfo);
  return [materialize(bytes, payloadStart, byteLength, tags[BYTES_TAG]!, options), payloadStart + byteLength];
}

/** Whether `tag` is an RFC 8746 typed-array tag this library decodes. */
export function isTypedArrayTag(tag: number): boolean {
  return tags[tag] !== undefined;
}

/** contentOffset is just after the tag header; the content must be a
 * definite-length byte string. tag must satisfy isTypedArrayTag. */
export function readTaggedContent(bytes: Uint8Array, contentOffset: number, tag: number, options: DecodeOptions | undefined): Decoded<TypedArray> {
  readable(bytes, contentOffset, 1);
  const token = bytes[contentOffset];
  const additionalInfo = token & 31;
  if (token >>> 5 !== Major.Bytes || additionalInfo === Info.Indefinite) {
    fail('invalid-header', contentOffset, 'Typed array tag must contain a definite-length byte string');
  }
  const byteLength = readArgumentValue(bytes, contentOffset + 1, additionalInfo);
  const payloadStart = argumentEnd(contentOffset + 1, additionalInfo);
  return [materialize(bytes, payloadStart, byteLength, tags[tag]!, options), payloadStart + byteLength];
}
