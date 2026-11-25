/** Decoded map keys, reused across messages. A repeated key skips UTF-8
 * decoding and, more importantly, V8 internalizing a brand-new string each
 * time it becomes a property name: object construction measured ~2.3x faster
 * with cached keys. Hits are confirmed byte for byte, so a hash collision only
 * costs a miss. Only keys that decoded as valid UTF-8 are stored, so a hit is
 * correct in every decode mode. Holds key text only, never values. */
const SLOT_COUNT = 1024;
const MAX_KEY_BYTES = 32;
const slotBytes: (Uint8Array | undefined)[] = Array.from({ length: SLOT_COUNT }, () => undefined);
const slotKeys: string[] = Array.from({ length: SLOT_COUNT }, () => '');

/** Hash of length plus first, middle and last byte. byteLength >= 1. */
function slotFor(bytes: Uint8Array, start: number, byteLength: number): number {
  const first = bytes[start];
  const middle = bytes[start + (byteLength >>> 1)];
  const last = bytes[start + byteLength - 1];
  return (byteLength * 31 + first * 7 + middle * 3 + last) & (SLOT_COUNT - 1);
}

export function lookup(bytes: Uint8Array, start: number, byteLength: number): string | undefined {
  if (byteLength === 0) return '';
  if (byteLength > MAX_KEY_BYTES) return undefined;
  const slot = slotFor(bytes, start, byteLength);
  const cached = slotBytes[slot];
  if (cached === undefined || cached.length !== byteLength) return undefined;
  for (let index = 0; index < byteLength; index++) {
    if (cached[index] !== bytes[start + index]) return undefined;
  }
  return slotKeys[slot];
}

/** Store a key whose bytes decoded as valid UTF-8. */
export function remember(bytes: Uint8Array, start: number, byteLength: number, key: string): void {
  if (byteLength === 0 || byteLength > MAX_KEY_BYTES) return;
  const slot = slotFor(bytes, start, byteLength);
  slotBytes[slot] = bytes.slice(start, start + byteLength);
  slotKeys[slot] = key;
}
