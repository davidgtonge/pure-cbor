import { readable, writable } from './binary.js';
import { argumentSize, writeArgument, MajorBits } from './header.js';
import { fail } from './error.js';
import type { TextWindow } from './state.js';
import type { DecodeOptions } from './types.js';

const encoder = new TextEncoder();
// ignoreBOM: true preserves an initial U+FEFF as part of the CBOR string.
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lenientDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
const fromCharCode = String.fromCharCode;

// Below this many UTF-16 units, a JS loop beats TextEncoder.encodeInto's call overhead.
const SHORT_ENCODE = 64;
// Up to this many bytes, JS decoding beats TextDecoder's call overhead (~60 ns).
const SHORT_DECODE = 32;

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => (unit & 0xfc00) === 0xdc00;

/** Exact UTF-8 byte length, with the same lone-surrogate policy as TextEncoder
 * (a lone surrogate becomes U+FFFD, 3 bytes). */
export function utf8Size(value: string): number {
  let byteLength = value.length;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) continue;
    if (unit < 0x800) byteLength += 1;
    else if (isHighSurrogate(unit) && index + 1 < value.length && isLowSurrogate(value.charCodeAt(index + 1))) {
      byteLength += 2; // the pair is 2 units and 4 bytes
      index++;
    } else byteLength += 2;
  }
  return byteLength;
}

export function size(value: string): number {
  const byteLength = utf8Size(value);
  return argumentSize(byteLength) + byteLength;
}

/** Upper bound without scanning: at most 3 UTF-8 bytes per UTF-16 unit. */
export function maxSize(value: string): number {
  const byteLength = value.length * 3;
  return argumentSize(byteLength) + byteLength;
}

/** Caller guarantees room for the full UTF-8 result. */
function writeUtf8(bytes: Uint8Array, offset: number, value: string): number {
  if (value.length >= SHORT_ENCODE) {
    return offset + encoder.encodeInto(value, bytes.subarray(offset)).written;
  }
  for (let index = 0; index < value.length; index++) {
    let codePoint = value.charCodeAt(index);
    if (codePoint < 0x80) {
      bytes[offset++] = codePoint;
    } else if (codePoint < 0x800) {
      bytes[offset++] = 0xc0 | (codePoint >>> 6);
      bytes[offset++] = 0x80 | (codePoint & 63);
    } else if (isHighSurrogate(codePoint) && index + 1 < value.length && isLowSurrogate(value.charCodeAt(index + 1))) {
      codePoint = 0x10000 + ((codePoint & 1023) << 10) + (value.charCodeAt(++index) & 1023);
      bytes[offset++] = 0xf0 | (codePoint >>> 18);
      bytes[offset++] = 0x80 | ((codePoint >>> 12) & 63);
      bytes[offset++] = 0x80 | ((codePoint >>> 6) & 63);
      bytes[offset++] = 0x80 | (codePoint & 63);
    } else {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd; // lone surrogate
      bytes[offset++] = 0xe0 | (codePoint >>> 12);
      bytes[offset++] = 0x80 | ((codePoint >>> 6) & 63);
      bytes[offset++] = 0x80 | (codePoint & 63);
    }
  }
  return offset;
}

/** Known exact byte length, e.g. after sizing an owned output. */
export function writeSized(bytes: Uint8Array, offset: number, value: string, byteLength: number): number {
  writable(bytes, offset, argumentSize(byteLength) + byteLength);
  const payloadStart = writeArgument(bytes, offset, MajorBits.Text, byteLength);
  return writeUtf8(bytes, payloadStart, value);
}

/** Exact-owned output for long strings: native UTF-8 avoids a slow JS sizing
 * pass; the temporary UTF-8 array is copied once. */
export function encodeOwned(value: string): Uint8Array {
  if (value.length >= SHORT_ENCODE) {
    const utf8 = encoder.encode(value);
    const bytes = new Uint8Array(argumentSize(utf8.length) + utf8.length);
    bytes.set(utf8, writeArgument(bytes, 0, MajorBits.Text, utf8.length));
    return bytes;
  }
  const byteLength = utf8Size(value);
  const bytes = new Uint8Array(argumentSize(byteLength) + byteLength);
  writeSized(bytes, 0, value, byteLength);
  return bytes;
}

/** Common path is single-pass into spare capacity, back-patching the header.
 * Tight buffers get exact sizing first, so an insufficient-capacity error never
 * partially writes the destination. */
export function write(bytes: Uint8Array, offset: number, value: string): number {
  if (maxSize(value) > bytes.length - offset) {
    return writeSized(bytes, offset, value, utf8Size(value));
  }
  const reservedHeader = argumentSize(value.length);
  const payloadStart = offset + reservedHeader;
  const payloadEnd = writeUtf8(bytes, payloadStart, value);
  const byteLength = payloadEnd - payloadStart;
  const actualHeader = argumentSize(byteLength);
  if (actualHeader !== reservedHeader) bytes.copyWithin(offset + actualHeader, payloadStart, payloadEnd);
  writeArgument(bytes, offset, MajorBits.Text, byteLength);
  return offset + actualHeader + byteLength;
}

/** Short ASCII: checks 8 bytes at a time and builds 8 characters per call.
 * Returns undefined at the first non-ASCII byte. */
function decodeAscii(bytes: Uint8Array, start: number, end: number): string | undefined {
  let position = start;
  let text = '';
  while (position + 8 <= end) {
    const byte0 = bytes[position], byte1 = bytes[position + 1], byte2 = bytes[position + 2], byte3 = bytes[position + 3];
    const byte4 = bytes[position + 4], byte5 = bytes[position + 5], byte6 = bytes[position + 6], byte7 = bytes[position + 7];
    if ((byte0 | byte1 | byte2 | byte3 | byte4 | byte5 | byte6 | byte7) & 0x80) return undefined;
    text += fromCharCode(byte0, byte1, byte2, byte3, byte4, byte5, byte6, byte7);
    position += 8;
  }
  if (position === end) return text;
  let highBits = 0;
  for (let index = position; index < end; index++) highBits |= bytes[index];
  if (highBits & 0x80) return undefined;
  return text + asciiTail(bytes, position, end - position);
}

/** Exactly `count` (1–7) characters in one call: one string, no concatenation. */
function asciiTail(bytes: Uint8Array, start: number, count: number): string {
  switch (count) {
    case 1: return fromCharCode(bytes[start]);
    case 2: return fromCharCode(bytes[start], bytes[start + 1]);
    case 3: return fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2]);
    case 4: return fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3]);
    case 5: return fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3], bytes[start + 4]);
    case 6: return fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3], bytes[start + 4],
      bytes[start + 5]);
    default: return fromCharCode(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3], bytes[start + 4],
      bytes[start + 5], bytes[start + 6]);
  }
}

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** Short UTF-8 in JS. Only well-formed input is decoded: overlong forms,
 * surrogates, values above U+10FFFF and truncated sequences return undefined,
 * so the native decoder makes every strict/replacement decision. */
function decodeShortUtf8(bytes: Uint8Array, start: number, end: number): string | undefined {
  const units: number[] = [];
  for (let position = start; position < end;) {
    const lead = bytes[position++];
    if (lead < 0x80) {
      units.push(lead);
    } else if (lead < 0xc2) {
      return undefined; // stray continuation byte or overlong 2-byte lead
    } else if (lead < 0xe0) {
      if (position >= end || !isContinuation(bytes[position])) return undefined;
      units.push(((lead & 0x1f) << 6) | (bytes[position++] & 0x3f));
    } else if (lead < 0xf0) {
      if (position + 1 >= end || !isContinuation(bytes[position]) || !isContinuation(bytes[position + 1])) return undefined;
      const codePoint = ((lead & 0x0f) << 12) | ((bytes[position] & 0x3f) << 6) | (bytes[position + 1] & 0x3f);
      position += 2;
      if (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
      units.push(codePoint);
    } else if (lead < 0xf5) {
      if (position + 2 >= end || !isContinuation(bytes[position]) ||
          !isContinuation(bytes[position + 1]) || !isContinuation(bytes[position + 2])) return undefined;
      const codePoint = ((lead & 0x07) << 18) | ((bytes[position] & 0x3f) << 12) |
        ((bytes[position + 1] & 0x3f) << 6) | (bytes[position + 2] & 0x3f);
      position += 3;
      if (codePoint < 0x10000 || codePoint > 0x10ffff) return undefined;
      units.push(0xd800 | ((codePoint - 0x10000) >> 10), 0xdc00 | (codePoint & 0x3ff));
    } else {
      return undefined; // 0xF5..0xFF never start a sequence
    }
  }
  return fromCharCode.apply(null, units);
}

/** Kept small so V8 can inline it into hot array and map loops; the native
 * decoder and its error handling live in decodeNative. A container decode
 * passes its state as `window`; a single top-level string has none. */
export function readPayload(bytes: Uint8Array, start: number, byteLength: number, options: DecodeOptions | undefined, window?: TextWindow): string {
  readable(bytes, start, byteLength);
  const end = start + byteLength;
  if (byteLength <= SHORT_DECODE) {
    // Inside a window already decoded, even a short string is cheaper as a slice.
    if (window !== undefined && byteLength >= MIN_SLICED && inWindow(window, start, end) && isAscii(bytes, start, end)) {
      return window.windowText.slice(start - window.windowStart, end - window.windowStart);
    }
    const decoded = decodeAscii(bytes, start, end) ?? decodeShortUtf8(bytes, start, end);
    if (decoded !== undefined) return decoded;
  }
  return decodeNative(bytes, start, end, options, window);
}

// Medium-length ASCII text: one TextDecoder call for many strings.
//
// Each TextDecoder call costs about 130 ns, whatever the length, and building
// longer strings in JS costs more. So rather than one call per string, the
// decoder takes a window of the input from the string onward, masks every
// byte to 7 bits, and decodes the window in one call. Masking makes the whole
// window ASCII, so it decodes one byte to one character at TextDecoder's
// fastest; only bytes outside strings (headers, numbers) are changed, and
// they are never read as text. Each ASCII string inside the window is then a
// slice of it, which V8 makes without copying. This is cbor-x's native
// string-extraction idea in pure JS. (A latin1 TextDecoder would need no
// mask, but it is Windows-1252: bytes 0x80-0x9F become two-byte characters.)
//
// The trade-off, as with the byte-string arena: a decoded string that is a
// slice keeps its window (at most WINDOW_BYTES) alive while it is referenced.

/** Bytes per window. Smaller windows decode fewer strings per call; 1 KiB
 * measured no gain over a call per string, 4 KiB about 10%. */
const WINDOW_BYTES = 4096;
/** Longer strings are decoded on their own: one call, and no window kept alive. */
const WINDOW_MAX_STRING = 256;
/** Shorter strings are built in JS even inside a window. From 13 characters V8
 * slices a string without copying; from 16, slicing measured faster than the
 * JS fast path (Bluesky-style records decode 1.24x faster with it, against
 * 1.07x from windows for strings over 32 bytes alone). */
const MIN_SLICED = 16;
/** Reused for every window. Like the encode staging buffer it holds no data
 * between calls: each window is decoded from it before it is written again. */
const windowScratch = new Uint8Array(WINDOW_BYTES);
const windowWords = new Uint32Array(windowScratch.buffer);

function isAscii(bytes: Uint8Array, start: number, end: number): boolean {
  let highBits = 0;
  let position = start;
  for (; position + 8 <= end; position += 8) {
    highBits |= bytes[position] | bytes[position + 1] | bytes[position + 2] | bytes[position + 3] |
      bytes[position + 4] | bytes[position + 5] | bytes[position + 6] | bytes[position + 7];
  }
  for (; position < end; position++) highBits |= bytes[position];
  return (highBits & 0x80) === 0;
}

const inWindow = (window: TextWindow, start: number, end: number): boolean =>
  start >= window.windowStart && end <= window.windowStart + window.windowText.length;

/** The ASCII string at [start, end) as a slice of the current window, or of
 * a new window starting at `start`. */
function sliceWindow(window: TextWindow, bytes: Uint8Array, start: number, end: number): string {
  if (!inWindow(window, start, end)) {
    const length = Math.min(bytes.length - start, WINDOW_BYTES);
    windowScratch.set(bytes.subarray(start, start + length));
    for (let index = 0; index < (length + 3) >>> 2; index++) windowWords[index] &= 0x7f7f7f7f;
    window.windowText = strictDecoder.decode(windowScratch.subarray(0, length));
    window.windowStart = start;
  }
  return window.windowText.slice(start - window.windowStart, end - window.windowStart);
}

function decodeNative(bytes: Uint8Array, start: number, end: number, options: DecodeOptions | undefined, window: TextWindow | undefined): string {
  if (window !== undefined && end - start < WINDOW_MAX_STRING && isAscii(bytes, start, end)) {
    return sliceWindow(window, bytes, start, end);
  }
  try {
    const decoder = options?.invalidUtf8 === 'replace' ? lenientDecoder : strictDecoder;
    return decoder.decode(bytes.subarray(start, end));
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    fail('invalid-utf8', start, 'Invalid UTF-8 text string');
  }
}
