import { arrayKind, checkOffset, readable, writable } from './binary.js';
import type { Binary } from './binary.js';
import { argumentEnd, argumentSize, readArgumentValue, writeArgument, Info, Major, MajorBits } from './header.js';
import * as NumberCodec from './number.js';
import * as StringCodec from './string.js';
import * as TypedArrayCodec from './typed-array.js';
import * as ArrayCodec from './array.js';
import * as MapCodec from './map.js';
import * as Simple from './simple.js';
import * as Tag from './tag.js';
import * as Bignum from './bignum.js';
import * as Indefinite from './indefinite.js';
import * as Arena from './arena.js';
import { fail } from './error.js';
import { createState, enterContainer, leaveContainer } from './state.js';
import type { DecodeState } from './state.js';
import { createWriter, DEFAULT_PROFILE, ensure, profileOf } from './writer.js';
import type { EncodeProfile, Writer, WriteValue } from './writer.js';
import { NOT_SCALAR, writeScalar } from './scalar.js';
import type { Value, DecodeOptions, Decoded, TypedArray } from './types.js';

/** Encode-side nesting limit; also turns cyclic input into a typed error. */
const MAX_ENCODE_DEPTH = 128;

function nestedDepth(depth: number): number {
  if (depth >= MAX_ENCODE_DEPTH) fail('depth-limit', 0, 'Nesting exceeds maximum depth (cyclic input?)');
  return depth + 1;
}

function unsupported(): never {
  fail('unsupported-type', 0, 'Unsupported value');
}

// ---------------------------------------------------------------- sizing

/** Encoded size: exact, or an upper bound that skips UTF-8 scanning. The
 * common types are tested first; the rarer variants follow. */
function measure(value: Value, upper: boolean, depth: number, shortestFloats: boolean): number {
  if (typeof value === 'number') return shortestFloats ? NumberCodec.sizeShortest(value) : NumberCodec.size(value);
  if (typeof value === 'string') return upper ? StringCodec.maxSize(value) : StringCodec.size(value);
  if (Simple.isSimple(value)) return 1;
  if (Array.isArray(value)) return ArrayCodec.measure(value, upper, nestedDepth(depth), measure, shortestFloats);
  if (MapCodec.isPlainObject(value)) return MapCodec.measureObject(value, upper, nestedDepth(depth), measure, shortestFloats);
  if (arrayKind(value) !== undefined) return TypedArrayCodec.size(value as TypedArray);
  if (typeof value === 'bigint') return Bignum.size(value);
  if (value instanceof Date) {
    const seconds = Tag.epochSeconds(value);
    return 1 + (shortestFloats ? NumberCodec.sizeShortest(seconds) : NumberCodec.size(seconds));
  }
  if (value instanceof Map) return MapCodec.measureMap(value, upper, nestedDepth(depth), measure, shortestFloats);
  if (Tag.isTagged(value)) return argumentSize(value.tag) + measure(value.value, upper, nestedDepth(depth), shortestFloats);
  if (Simple.isSimpleValue(value)) return Simple.simpleSize(value);
  return unsupported();
}

export function encodedSize(value: Value, profile: EncodeProfile = DEFAULT_PROFILE): number {
  return measure(value, false, 0, profile.shortestFloats);
}

export function maxEncodedSize(value: Value, profile: EncodeProfile = DEFAULT_PROFILE): number {
  return measure(value, true, 0, profile.shortestFloats);
}

// ---------------------------------------------------------------- writing

/** Write one value at the writer's cursor. Growable writers grow as needed;
 * fixed writers were preflighted by the caller. */
export function writeValue(writer: Writer, value: Value, depth: number): void {
  const end = writeScalar(writer, writer.position, value);
  if (end !== NOT_SCALAR) {
    writer.position = end;
  } else if (Array.isArray(value)) {
    ArrayCodec.write(writer, value, nestedDepth(depth), writeValue);
  } else if (MapCodec.isPlainObject(value)) {
    MapCodec.writeObject(writer, value, nestedDepth(depth), writeValue);
  } else if (value instanceof Uint8Array) { // and Buffer: a byte string, no kind lookup
    ensure(writer, 9 + value.length);
    writer.position = TypedArrayCodec.writeByteString(writer.bytes, writer.position, value);
  } else if (arrayKind(value) !== undefined) {
    ensure(writer, TypedArrayCodec.size(value as TypedArray));
    writer.position = TypedArrayCodec.write(writer.bytes, writer.position, value as TypedArray);
  } else {
    writeRareValue(writer, value, depth);
  }
}

/** bigint, Date, Map, Tagged and SimpleValue. */
function writeRareValue(writer: Writer, value: Value, depth: number): void {
  if (typeof value === 'bigint') {
    ensure(writer, Bignum.size(value));
    writer.position = Bignum.write(writer.bytes, writer.position, value);
  } else if (value instanceof Date) {
    writeDate(writer, value, false);
  } else if (value instanceof Map) {
    MapCodec.writeMap(writer, value, nestedDepth(depth), writeValue);
  } else if (Tag.isTagged(value)) {
    ensure(writer, argumentSize(value.tag));
    writer.position = writeArgument(writer.bytes, writer.position, MajorBits.Tag, value.tag);
    writeValue(writer, value.value, nestedDepth(depth));
  } else if (Simple.isSimpleValue(value)) {
    ensure(writer, Simple.simpleSize(value));
    writer.position = Simple.writeSimpleValue(writer.bytes, writer.position, value);
  } else {
    unsupported();
  }
}

function writeDate(writer: Writer, date: Date, shortestFloats: boolean): void {
  const seconds = Tag.epochSeconds(date);
  ensure(writer, 10);
  writer.bytes[writer.position] = Tag.EPOCH_TIME_HEADER;
  const writeNumber = shortestFloats ? NumberCodec.writeShortest : NumberCodec.write;
  writer.position = writeNumber(writer.bytes, writer.position + 1, seconds);
}

/** A write function for non-default options (shortest floats, sorted keys).
 * These modes are opt-in and slower anyway (sorting), so this is a plain
 * recursive dispatcher; keeping it separate means the default writeValue
 * never checks options. (Reading them per object cost ~10% on small objects.) */
function optionsWriter(profile: EncodeProfile): WriteValue {
  const { shortestFloats, sortKeys } = profile;
  const writeWithOptions: WriteValue = (writer, value, depth) => {
    if (typeof value === 'number') {
      ensure(writer, 9);
      writer.position = (shortestFloats ? NumberCodec.writeShortest : NumberCodec.write)(writer.bytes, writer.position, value);
    } else if (Array.isArray(value)) {
      ensure(writer, 9);
      writer.position = writeArgument(writer.bytes, writer.position, MajorBits.Array, value.length);
      for (let index = 0; index < value.length; index++) writeWithOptions(writer, value[index], nestedDepth(depth));
    } else if (MapCodec.isPlainObject(value) || value instanceof Map) {
      const entries = value instanceof Map ? [...value] : MapCodec.objectEntries(value);
      const writeEntries = sortKeys ? MapCodec.writeSortedEntries : MapCodec.writeEntries;
      writeEntries(writer, entries, nestedDepth(depth), writeWithOptions);
    } else if (value instanceof Date) {
      writeDate(writer, value, shortestFloats);
    } else if (Tag.isTagged(value)) {
      ensure(writer, argumentSize(value.tag));
      writer.position = writeArgument(writer.bytes, writer.position, MajorBits.Tag, value.tag);
      writeWithOptions(writer, value.value, nestedDepth(depth));
    } else {
      writeValue(writer, value, depth); // strings, simple values, typed arrays, bigint: no options apply
    }
  };
  return writeWithOptions;
}

const writers = new Map<EncodeProfile, WriteValue>();

/** The write function for an encode profile. The default needs no lookup:
 * this runs on every encode call. */
export function writerFor(profile: EncodeProfile): WriteValue {
  if (profile === DEFAULT_PROFILE) return writeValue;
  let writer = writers.get(profile);
  if (writer === undefined) {
    writer = optionsWriter(profile);
    writers.set(profile, writer);
  }
  return writer;
}

/** The deterministic writer, which decoding uses to compare Map keys that
 * are objects: equal CBOR values have equal deterministic encodings. */
const writeCanonical: WriteValue = (writer, value, depth) => writerFor(profileOf({ deterministic: true }))(writer, value, depth);

/** Append one item into caller memory. A capacity error never partially
 * writes: scalars check their own size, everything else is measured first. */
export function writeBytes(bytes: Uint8Array, offset: number, value: Value, profile: EncodeProfile = DEFAULT_PROFILE): number {
  checkOffset(bytes, offset);
  if (typeof value === 'number') {
    return profile.shortestFloats ? NumberCodec.writeShortest(bytes, offset, value) : NumberCodec.write(bytes, offset, value);
  }
  if (typeof value === 'string') return StringCodec.write(bytes, offset, value);
  if (Simple.isSimple(value)) return Simple.write(bytes, offset, value);
  if (arrayKind(value) !== undefined) return TypedArrayCodec.write(bytes, offset, value as TypedArray);
  if (measure(value, true, 0, profile.shortestFloats) > bytes.length - offset) {
    writable(bytes, offset, measure(value, false, 0, profile.shortestFloats));
  }
  const writer = createWriter(bytes, offset, false);
  writerFor(profile)(writer, value, 0);
  return writer.position;
}

export function write(buffer: Binary, offset: number, value: Value, profile: EncodeProfile = DEFAULT_PROFILE): number {
  return writeBytes(buffer.bytes, offset, value, profile);
}

// ---------------------------------------------------------------- reading

/** A tag: typed arrays read their byte-string content directly; every other
 * tag decodes its content (counted toward maxDepth) and then converts it.
 * state.position is just after the tag's initial byte. */
function readTag(state: DecodeState, additionalInfo: number): Value {
  const bytes = state.bytes;
  const headerOffset = state.position - 1;
  const tag = readArgumentValue(bytes, state.position, additionalInfo);
  const contentOffset = argumentEnd(state.position, additionalInfo);
  if (TypedArrayCodec.isTypedArrayTag(tag) && !Tag.hasCustomDecoder(state.options, tag)) {
    const [value, end] = TypedArrayCodec.readTaggedContent(bytes, contentOffset, tag, state.options);
    state.position = end;
    return value;
  }
  state.position = contentOffset;
  enterContainer(state, 1, headerOffset);
  const content = readValue(state);
  leaveContainer(state);
  return Tag.decodeTag(tag, content, state.options, headerOffset);
}

/** Read one nested item at the cursor and advance it. */
export function readValue(state: DecodeState): Value {
  const bytes = state.bytes;
  let position = state.position;
  readable(bytes, position, 1);
  const token = bytes[position++];
  if (token < 24) {
    state.position = position;
    return token; // small unsigned integer: the token is the value
  }
  const additionalInfo = token & 31;
  switch (token >>> 5) {
    case Major.Unsigned: case Major.Negative: {
      const value = NumberCodec.readValue(bytes, position, token);
      state.position = argumentEnd(position, additionalInfo);
      return value;
    }
    case Major.Simple: {
      const value = Simple.readMajor7(bytes, position, token);
      state.position = argumentEnd(position, additionalInfo);
      return value;
    }
    case Major.Text: {
      if (additionalInfo !== Info.Indefinite) {
        // Definite text inline: no result tuple on the most common path.
        const byteLength = readArgumentValue(bytes, position, additionalInfo);
        const start = argumentEnd(position, additionalInfo);
        const value = StringCodec.readPayload(bytes, start, byteLength, state.options);
        state.position = start + byteLength;
        return value;
      }
      const [value, end] = Indefinite.readChunked(bytes, position, Major.Text, state.options);
      state.position = end;
      return value;
    }
    case Major.Bytes: {
      if (additionalInfo !== Info.Indefinite && state.useArena) {
        const byteLength = readArgumentValue(bytes, position, additionalInfo);
        const start = argumentEnd(position, additionalInfo);
        readable(bytes, start, byteLength);
        state.position = start + byteLength;
        return Arena.copyByteString(state, start, byteLength);
      }
      const [value, end] = readByteString(bytes, position, additionalInfo, state.options);
      state.position = end;
      return value;
    }
    case Major.Array:
      state.position = position;
      return ArrayCodec.read(state, additionalInfo, readValue);
    case Major.Map:
      state.position = position;
      return MapCodec.read(state, additionalInfo, readValue, writeCanonical);
    default: // Major.Tag, the only major type left
      state.position = position;
      return readTag(state, additionalInfo);
  }
}

/** A byte string, definite or chunked, as its own buffer (or a view when
 * borrowing). offset is just after the initial byte. */
function readByteString(bytes: Uint8Array, offset: number, additionalInfo: number, options: DecodeOptions | undefined): Decoded {
  if (additionalInfo === Info.Indefinite) return Indefinite.readChunked(bytes, offset, Major.Bytes, options);
  return TypedArrayCodec.readBytes(bytes, offset, additionalInfo, options);
}

/** Top-level dispatch. Scalars, strings and typed arrays are read directly
 * (no state, and no tuple for whole-value reads); containers and other tags
 * create one DecodeState for their tree. */
function readItem(buffer: Binary, offset: number, options: DecodeOptions | undefined, whole: true): Value;
function readItem(buffer: Binary, offset: number, options: DecodeOptions | undefined, whole: false): Decoded;
function readItem(buffer: Binary, offset: number, options: DecodeOptions | undefined, whole: boolean): Value | Decoded {
  const bytes = buffer.bytes;
  checkOffset(bytes, offset);
  readable(bytes, offset, 1);
  const token = bytes[offset++];
  const majorType = token >>> 5;
  const additionalInfo = token & 31;
  let value: Value;
  let end: number;
  switch (majorType) {
    case Major.Unsigned: case Major.Negative:
      value = NumberCodec.readValue(bytes, offset, token);
      end = argumentEnd(offset, additionalInfo);
      break;
    case Major.Simple:
      value = Simple.readMajor7(bytes, offset, token);
      end = argumentEnd(offset, additionalInfo);
      break;
    case Major.Text:
      if (additionalInfo !== Info.Indefinite) {
        // Definite text inline: no result tuple on the most common path.
        const byteLength = readArgumentValue(bytes, offset, additionalInfo);
        const start = argumentEnd(offset, additionalInfo);
        value = StringCodec.readPayload(bytes, start, byteLength, options);
        end = start + byteLength;
      } else {
        [value, end] = Indefinite.readChunked(bytes, offset, Major.Text, options);
      }
      break;
    case Major.Bytes:
      [value, end] = readByteString(bytes, offset, additionalInfo, options);
      break;
    default: { // arrays, maps and tags
      const state = createState(bytes, offset, options);
      value = majorType === Major.Array ? ArrayCodec.read(state, additionalInfo, readValue)
        : majorType === Major.Map ? MapCodec.read(state, additionalInfo, readValue, writeCanonical)
        : readTag(state, additionalInfo);
      end = state.position;
    }
  }
  if (whole) {
    if (end !== bytes.length) fail('trailing-data', end, 'Unexpected bytes after CBOR value');
    return value;
  }
  return [value, end];
}

export function read(buffer: Binary, offset: number, options?: DecodeOptions): Decoded {
  return readItem(buffer, offset, options, false);
}

/** Prepared-buffer whole-value decode, useful for reused input views. */
export function readWhole(buffer: Binary, options?: DecodeOptions): Value {
  return readItem(buffer, 0, options, true);
}
