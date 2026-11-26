import { readable } from './binary.js';
import { argumentEnd, argumentSize, readArgumentValue, writeArgument, Info, Major, MajorBits, Token } from './header.js';
import * as NumberCodec from './number.js';
import * as StringCodec from './string.js';
import * as Simple from './simple.js';
import { fail } from './error.js';
import { enterContainer, leaveContainer } from './state.js';
import type { DecodeState, ReadValue } from './state.js';
import { roomFor } from './writer.js';
import type { MeasureValue, Writer, WriteValue } from './writer.js';
import type { Value } from './types.js';


/** Pure sizing and validation. Scalars inline; nested items via the dispatcher.
 * Holes count as undefined. */
export function measure(values: readonly Value[], upper: boolean, depth: number, measureValue: MeasureValue, shortestFloats: boolean): number {
  let total = argumentSize(values.length);
  for (let index = 0; index < values.length; index++) {
    const element = values[index];
    if (typeof element === 'number') total += shortestFloats ? NumberCodec.sizeShortest(element) : NumberCodec.size(element);
    else if (typeof element === 'string') total += upper ? StringCodec.maxSize(element) : StringCodec.size(element);
    else total += measureValue(element, upper, depth, shortestFloats);
  }
  if (!Number.isSafeInteger(total)) fail('invalid-length', 0, 'Encoded array size exceeds safe integer range');
  return total;
}

/** Scalars are written inline with a local cursor (the hot path); only
 * nested items go through the dispatcher. The scalar branches are spelled out
 * here rather than calling writeScalar: V8 often declines to inline a shared
 * helper into this loop, and that measured 10-20% slower. */
export function write(writer: Writer, values: readonly Value[], depth: number, writeValue: WriteValue): void {
  let position = writeArgument(roomFor(writer, writer.position, 9), writer.position, MajorBits.Array, values.length);
  for (let index = 0; index < values.length; index++) {
    const element = values[index];
    if (typeof element === 'number') {
      position = NumberCodec.write(roomFor(writer, position, 9), position, element);
    } else if (typeof element === 'string') {
      position = StringCodec.write(roomFor(writer, position, StringCodec.maxSize(element)), position, element);
    } else if (Simple.isSimple(element)) { // includes undefined and holes
      roomFor(writer, position, 1)[position++] = Simple.tokenOf(element);
    } else {
      writer.position = position;
      writeValue(writer, element, depth);
      position = writer.position;
    }
  }
  writer.position = position;
}

/** One local cursor and one result allocation. Scalars are decoded inline with
 * no per-element tuples; only nested items go through the dispatcher.
 * state.position is immediately after the array's initial byte. */
export function read(state: DecodeState, additionalInfo: number, readValue: ReadValue): Value[] {
  if (additionalInfo === Info.Indefinite) return readIndefinite(state, readValue);
  const bytes = state.bytes;
  const headerOffset = state.position - 1;
  const length = readArgumentValue(bytes, state.position, additionalInfo);
  let position = argumentEnd(state.position, additionalInfo);
  if (length > state.maxArrayLength) fail('array-limit', headerOffset, 'Array exceeds maxArrayLength');
  // Each element requires at least one byte, even for empty text.
  readable(bytes, position, length);
  enterContainer(state, length, headerOffset);
  // Preallocated (holey) beats push by ~1.6x here; holey elements had no
  // measurable cost for consumers (indexing, map, for-of) in V8.
  // oxlint-disable-next-line unicorn/no-new-array -- a length, deliberately
  const values: Value[] = new Array(length);
  for (let index = 0; index < length; index++) {
    readable(bytes, position, 1);
    const token = bytes[position++];
    if (token < 24) {
      values[index] = token; // small unsigned integer: the token is the value
      continue;
    }
    if (token === Token.Float64) {
      readable(bytes, position, 8);
      // DataView.getFloat64 is an intrinsic and the fastest path, but building
      // a DataView over a small on-heap buffer is costly. Inputs over 64 bytes
      // are already off-heap, so one view is shared by the whole decode.
      if (state.floatView === undefined && bytes.length > 64) {
        state.floatView = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      }
      values[index] = state.floatView !== undefined
        ? state.floatView.getFloat64(position)
        : NumberCodec.readFloat64(bytes, position);
      position += 8;
      continue;
    }
    if (Simple.isToken(token)) {
      values[index] = Simple.valueOf(token);
      continue;
    }
    const majorType = token >>> 5;
    const elementInfo = token & 31;
    if (majorType === Major.Text && elementInfo !== Info.Indefinite) {
      const byteLength = readArgumentValue(bytes, position, elementInfo);
      position = argumentEnd(position, elementInfo);
      values[index] = StringCodec.readPayload(bytes, position, byteLength, state.options, state);
      position += byteLength;
    } else if (majorType === Major.Unsigned && elementInfo < Info.EightBytes) {
      values[index] = readArgumentValue(bytes, position, elementInfo);
      position = argumentEnd(position, elementInfo);
    } else if (majorType <= Major.Negative) { // unsigned or negative, including 64-bit arguments (maybe bigints)
      values[index] = NumberCodec.readValue(bytes, position, token);
      position = argumentEnd(position, elementInfo);
    } else if (majorType === Major.Simple) {
      values[index] = Simple.readMajor7(bytes, position, token);
      position = argumentEnd(position, elementInfo);
    } else {
      // Nested array, map, byte string, tag or chunked text: the dispatcher
      // reads from the token.
      state.position = position - 1;
      values[index] = readValue(state);
      position = state.position;
    }
  }
  state.position = position;
  leaveContainer(state);
  return values;
}

/** An indefinite-length array: items until a break. Nothing is preallocated,
 * so only the length limit applies as items arrive. */
function readIndefinite(state: DecodeState, readValue: ReadValue): Value[] {
  const bytes = state.bytes;
  const headerOffset = state.position - 1;
  enterContainer(state, 0, headerOffset);
  const values: Value[] = [];
  for (;;) {
    readable(bytes, state.position, 1);
    if (bytes[state.position] === Token.Break) {
      state.position++;
      break;
    }
    if (values.length >= state.maxArrayLength) fail('array-limit', headerOffset, 'Array exceeds maxArrayLength');
    values.push(readValue(state));
  }
  leaveContainer(state);
  return values;
}
