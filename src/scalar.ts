import * as NumberCodec from './number.js';
import * as StringCodec from './string.js';
import * as Simple from './simple.js';
import { roomFor } from './writer.js';
import type { Writer } from './writer.js';

/** Returned by writeScalar when the value is not a scalar. */
export const NOT_SCALAR = -1;

/** Above this many UTF-16 units, size strings exactly rather than reserving 3 bytes per unit. */
const LARGE_STRING = 16 * 1024;

/** Write a number, string, boolean, null or undefined at `position` and
 * return the new position, or NOT_SCALAR for anything else. */
export function writeScalar(writer: Writer, position: number, value: unknown): number {
  if (typeof value === 'number') {
    return NumberCodec.write(roomFor(writer, position, 9), position, value);
  }
  if (typeof value === 'string') {
    const capacity = value.length > LARGE_STRING ? StringCodec.size(value) : StringCodec.maxSize(value);
    return StringCodec.write(roomFor(writer, position, capacity), position, value);
  }
  if (Simple.isSimple(value)) {
    roomFor(writer, position, 1)[position] = Simple.tokenOf(value);
    return position + 1;
  }
  return NOT_SCALAR;
}
