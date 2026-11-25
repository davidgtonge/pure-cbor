import { fail } from './error.js';

/** Immutable descriptor over explicitly mutable memory. No cursor.
 * Deliberately holds no DataView: reading `.buffer` on a small, freshly
 * allocated Uint8Array forces V8 to externalize its backing store, which costs
 * far more than encoding or decoding a small value. */
export type Binary = Readonly<{ bytes: Uint8Array }>;

const typedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag,
)!.get!;

/** Intrinsic getter, not a user-supplied constructor or Symbol.toStringTag. */
export function arrayKind(value: unknown): string | undefined {
  return typedArrayName.call(value) as string | undefined;
}

/** Prepare once when repeatedly reading/writing the same buffer. */
export function binary(bytes: Uint8Array): Binary {
  if (!(bytes instanceof Uint8Array) && arrayKind(bytes) !== 'Uint8Array') {
    fail('invalid-buffer', 0, 'Expected a Uint8Array');
  }
  return { bytes };
}

export function checkOffset(bytes: Uint8Array, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) {
    fail('invalid-offset', offset, 'Offset is outside the byte view');
  }
}

// Internal callers have already validated offset and count as nonnegative integers.
export function readable(bytes: Uint8Array, offset: number, count: number): void {
  if (count > bytes.length - offset) {
    fail('truncated', offset, 'Unexpected end of CBOR input');
  }
}

export function writable(bytes: Uint8Array, offset: number, count: number): void {
  if (count > bytes.length - offset) {
    fail('capacity', offset, 'Insufficient destination capacity');
  }
}

export const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
