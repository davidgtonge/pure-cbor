import { readable } from './binary.js';
import { fail } from './error.js';

// A CBOR data item starts with an initial byte: the major type in the top 3
// bits and "additional info" in the low 5. Additional info below 24 is the
// argument itself; 24–27 mean the argument follows in 1, 2, 4 or 8 bytes;
// 31 marks an indefinite length. Read them as `token >>> 5` and `token & 31`.

// Named wire constants. Const enums: the compiler substitutes each value at
// its use site, so hot loops compare against literals. (Imported `const`
// bindings measured ~15% slower in the array decoder.)

/** Major types, as read from an initial byte with `token >>> 5`. */
export const enum Major { Unsigned = 0, Negative = 1, Bytes = 2, Text = 3, Array = 4, Map = 5, Tag = 6, Simple = 7 }

/** Major types shifted into place, for writing an initial byte. */
export const enum MajorBits {
  Unsigned = Major.Unsigned << 5, Negative = Major.Negative << 5, Bytes = Major.Bytes << 5, Text = Major.Text << 5,
  Array = Major.Array << 5, Map = Major.Map << 5, Tag = Major.Tag << 5, Simple = Major.Simple << 5,
}

/** Additional info (`token & 31`) values with a meaning of their own. */
export const enum Info { OneByte = 24, EightBytes = 27, Indefinite = 31 }

/** Whole initial bytes. */
export const enum Token { Float64 = 0xfb, Break = 0xff }

const MAX_UINT32 = 0xffffffff;
const TWO_POW_32 = 0x100000000;

/** Preferred argument width (including the initial byte), for validated safe integers. */
export function argumentSize(argument: number): number {
  return argument < 24 ? 1 : argument < 256 ? 2 : argument < 65536 ? 3 : argument <= MAX_UINT32 ? 5 : 9;
}

/** Big-endian 32-bit store without a DataView. */
export function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

/** Big-endian unsigned 32-bit load without a DataView. */
export function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
}

/** majorBits is the already-shifted major type, e.g. 0x60 for text.
 * Internal primitive: the caller checks capacity for header and payload once. */
export function writeArgument(bytes: Uint8Array, offset: number, majorBits: number, argument: number): number {
  if (argument < 24) {
    bytes[offset] = majorBits | argument;
    return offset + 1;
  }
  if (argument < 256) {
    bytes[offset] = majorBits | 24;
    bytes[offset + 1] = argument;
    return offset + 2;
  }
  if (argument < 65536) {
    bytes[offset] = majorBits | 25;
    bytes[offset + 1] = argument >>> 8;
    bytes[offset + 2] = argument;
    return offset + 3;
  }
  if (argument <= MAX_UINT32) {
    bytes[offset] = majorBits | 26;
    writeUint32(bytes, offset + 1, argument);
    return offset + 5;
  }
  bytes[offset] = majorBits | 27;
  writeUint32(bytes, offset + 1, Math.floor(argument / TWO_POW_32));
  writeUint32(bytes, offset + 5, argument >>> 0);
  return offset + 9;
}

/** offset is immediately after the initial byte. Non-preferred widths are accepted. */
export function readArgumentValue(bytes: Uint8Array, offset: number, additionalInfo: number): number {
  if (additionalInfo < 24) return additionalInfo;
  switch (additionalInfo) {
    case 24:
      readable(bytes, offset, 1);
      return bytes[offset];
    case 25:
      readable(bytes, offset, 2);
      return (bytes[offset] << 8) | bytes[offset + 1];
    case 26:
      readable(bytes, offset, 4);
      return readUint32(bytes, offset);
    case 27: {
      readable(bytes, offset, 8);
      const high = readUint32(bytes, offset);
      if (high > 0x1fffff) fail('integer-overflow', offset - 1, 'CBOR argument exceeds safe integer range');
      return high * TWO_POW_32 + readUint32(bytes, offset + 4);
    }
    default:
      fail('invalid-header', offset - 1, 'Reserved or indefinite-length argument');
  }
}

/** Offset after an argument whose additional info and bounds are already validated. */
export function argumentEnd(offset: number, additionalInfo: number): number {
  return additionalInfo < 24 ? offset : offset + (1 << (additionalInfo - 24));
}
