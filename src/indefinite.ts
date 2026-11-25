import { readable } from './binary.js';
import { argumentEnd, readArgumentValue, Info, Major, Token } from './header.js';
import * as StringCodec from './string.js';
import { CborError, fail } from './error.js';
import type { DecodeOptions, Decoded } from './types.js';

// Indefinite-length byte and text strings (5f / 7f ... ff): definite-length
// chunks of the same major type, ended by a break. Decode only; this library
// always encodes definite lengths.
//
// Chunks can be as small as one byte, so nothing here allocates per chunk: a
// view or a string for every two bytes of input would let a message cost far
// more memory than its size. One pass reads the headers and adds up the
// length, the second copies the payloads into one buffer.

/** Payloads shorter than this are copied byte by byte: a subarray for set()
 * would be one allocation per chunk. */
const SHORT_CHUNK = 32;

/** offset is just after the 5f/7f initial byte. Text chunks must each be
 * valid UTF-8 on their own (RFC 8949 §3.2.3). Byte strings are copied. */
export function readChunked(bytes: Uint8Array, offset: number, majorType: number, options: DecodeOptions | undefined): Decoded<string | Uint8Array> {
  const isText = majorType === Major.Text;
  let byteLength = 0;
  let splitsCharacter = false;
  let position = offset;
  for (;;) {
    readable(bytes, position, 1);
    const token = bytes[position++];
    if (token === Token.Break) break;
    const additionalInfo = token & 31;
    if (token >>> 5 !== majorType || additionalInfo === Info.Indefinite) {
      fail('invalid-header', position - 1, 'Indefinite-length string chunks must be definite strings of the same type');
    }
    const length = readArgumentValue(bytes, position, additionalInfo);
    const start = argumentEnd(position, additionalInfo);
    readable(bytes, start, length);
    if (isText && !holdsWholeCharacters(bytes, start, length)) {
      if (options?.invalidUtf8 !== 'replace') fail('invalid-utf8', start, 'Invalid UTF-8 text string');
      splitsCharacter = true;
    }
    byteLength += length;
    position = start + length;
  }
  const end = position;
  if (isText && splitsCharacter) return [readTextChunks(bytes, offset, options), end];
  const joined = joinChunks(bytes, offset, byteLength);
  if (!isText) return [joined, end];
  try {
    return [StringCodec.readPayload(joined, 0, byteLength, options), end];
  } catch (error) {
    if (!(error instanceof CborError)) throw error;
    // Invalid UTF-8 inside a chunk: decode chunk by chunk to report its offset.
    return [readTextChunks(bytes, offset, options), end];
  }
}

/** The second pass: chunk headers were checked by the first. */
function joinChunks(bytes: Uint8Array, offset: number, byteLength: number): Uint8Array {
  const joined = new Uint8Array(byteLength);
  let written = 0;
  let position = offset;
  while (bytes[position] !== Token.Break) {
    const additionalInfo = bytes[position] & 31;
    const length = readArgumentValue(bytes, position + 1, additionalInfo);
    const start = argumentEnd(position + 1, additionalInfo);
    if (length < SHORT_CHUNK) {
      for (let index = 0; index < length; index++) joined[written + index] = bytes[start + index];
    } else {
      joined.set(bytes.subarray(start, start + length), written);
    }
    written += length;
    position = start + length;
  }
  return joined;
}

/** Each chunk decoded on its own: exact error offsets, and replacement
 * characters exactly where a chunk boundary splits a character. */
function readTextChunks(bytes: Uint8Array, offset: number, options: DecodeOptions | undefined): string {
  let text = '';
  let position = offset;
  while (bytes[position] !== Token.Break) {
    const additionalInfo = bytes[position] & 31;
    const length = readArgumentValue(bytes, position + 1, additionalInfo);
    const start = argumentEnd(position + 1, additionalInfo);
    text += StringCodec.readPayload(bytes, start, length, options);
    position = start + length;
  }
  return text;
}

/** Whether a text chunk starts and ends on character boundaries. Invalid
 * bytes inside it are left to the decoder. */
function holdsWholeCharacters(bytes: Uint8Array, start: number, length: number): boolean {
  if (length === 0) return true;
  if ((bytes[start] & 0xc0) === 0x80) return false; // starts with a continuation byte
  const end = start + length;
  let lead = end - 1;
  while (lead > start && end - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
  const leadByte = bytes[lead];
  const sequenceLength = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : leadByte >= 0xc0 ? 2 : 1;
  return end - lead >= sequenceLength;
}
