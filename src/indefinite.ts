import { readable } from './binary.js';
import { argumentEnd, readArgumentValue, Info, Major, Token } from './header.js';
import * as StringCodec from './string.js';
import { fail } from './error.js';
import type { DecodeOptions, Decoded } from './types.js';

// Indefinite-length byte and text strings (5f / 7f ... ff): definite-length
// chunks of the same major type, ended by a break. Decode only; this library
// always encodes definite lengths.

/** offset is just after the 5f/7f initial byte. Text chunks must each be
 * valid UTF-8 on their own (RFC 8949 §3.2.3). Byte strings are copied. */
export function readChunked(bytes: Uint8Array, offset: number, majorType: number, options: DecodeOptions | undefined): Decoded<string | Uint8Array> {
  const texts: string[] = [];
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
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
    if (majorType === Major.Text) texts.push(StringCodec.readPayload(bytes, start, length, options));
    else chunks.push(bytes.subarray(start, start + length));
    byteLength += length;
    position = start + length;
  }
  if (majorType === Major.Text) return [texts.join(''), position];
  const joined = new Uint8Array(byteLength);
  let written = 0;
  for (const chunk of chunks) {
    joined.set(chunk, written);
    written += chunk.length;
  }
  return [joined, position];
}
