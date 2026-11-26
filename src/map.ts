import { readable } from './binary.js';
import { argumentEnd, argumentSize, readArgumentValue, writeArgument, Info, Major, MajorBits, Token } from './header.js';
import * as NumberCodec from './number.js';
import * as StringCodec from './string.js';
import * as Simple from './simple.js';
import * as Tag from './tag.js';
import * as TypedArrayCodec from './typed-array.js';
import * as KeyCache from './keys.js';
import { fail } from './error.js';
import { enterContainer, leaveContainer } from './state.js';
import type { DecodeState, ReadValue } from './state.js';
import { createWriter, ensure, roomFor } from './writer.js';
import type { MeasureValue, Writer, WriteValue } from './writer.js';
import type { Value, ValueObject } from './types.js';

// CBOR maps <-> plain objects (text keys) and Map (any keys).

/** entryCount of an indefinite-length map: entries until a break. */
const UNTIL_BREAK = -1;

/** Plain objects only: prototype Object.prototype or null. Dates, Maps, class
 * instances and boxed primitives are rejected rather than silently flattened. */
export function isPlainObject(value: unknown): value is ValueObject {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True if Object.prototype has gained enumerable properties (prototype
 * pollution), which `for...in` would otherwise report as the object's own. */
function objectPrototypeHasEnumerableKeys(): boolean {
  for (const _ in Object.prototype) return true;
  return false;
}

/** Own enumerable string keys in Object.keys order; undefined values omitted.
 *
 * Enumeration: `for...in` reads properties through V8's enum cache with no
 * array allocations, ~3x faster than Object.keys + Object.values. For plain
 * objects it can only add inherited keys if Object.prototype itself has been
 * given enumerable properties, so the own-property check runs only then. */
export function measureObject(object: ValueObject, upper: boolean, depth: number, measureValue: MeasureValue, shortestFloats: boolean): number {
  const checkOwn = objectPrototypeHasEnumerableKeys();
  let entryCount = 0;
  let total = 0;
  for (const key in object) {
    if (checkOwn && !Object.hasOwn(object, key)) continue;
    const value = object[key];
    if (value === undefined) continue;
    entryCount++;
    total += (upper ? StringCodec.maxSize(key) : StringCodec.size(key)) + measureValue(value, upper, depth, shortestFloats);
  }
  total += argumentSize(entryCount);
  if (!Number.isSafeInteger(total)) fail('invalid-length', 0, 'Encoded map size exceeds safe integer range');
  return total;
}

/** One pass with a local cursor. The entry count is only known at the end, so
 * a 1-byte header (fewer than 24 entries, the common case) is reserved and
 * filled in last; larger maps shift their entries right to fit the wider
 * header, which keeps the preferred (smallest) encoding. */
export function writeObject(writer: Writer, object: ValueObject, depth: number, writeValue: WriteValue): void {
  const checkOwn = objectPrototypeHasEnumerableKeys();
  const headerOffset = writer.position;
  roomFor(writer, headerOffset, 1);
  let position = headerOffset + 1;
  let entryCount = 0;
  for (const key in object) {
    if (checkOwn && !Object.hasOwn(object, key)) continue;
    const value = object[key];
    if (value === undefined) continue;
    entryCount++;
    position = writeKey(writer, position, key);
    // Scalar values inline, as in the array writer (see the note there).
    if (typeof value === 'number') {
      position = NumberCodec.write(roomFor(writer, position, 9), position, value);
    } else if (typeof value === 'string') {
      position = StringCodec.write(roomFor(writer, position, StringCodec.maxSize(value)), position, value);
    } else if (Simple.isSimple(value)) {
      roomFor(writer, position, 1)[position++] = Simple.tokenOf(value);
    } else {
      writer.position = position;
      writeValue(writer, value, depth);
      position = writer.position;
    }
  }
  const extraHeaderBytes = argumentSize(entryCount) - 1;
  const bytes = roomFor(writer, position, extraHeaderBytes);
  if (extraHeaderBytes > 0) {
    bytes.copyWithin(headerOffset + 1 + extraHeaderBytes, headerOffset + 1, position);
    position += extraHeaderBytes;
  }
  writeArgument(bytes, headerOffset, MajorBits.Map, entryCount);
  writer.position = position;
}

/** Keys are usually short ASCII: write the 1-byte header and the characters
 * directly. Anything else goes through the general text writer. */
function writeKey(writer: Writer, position: number, key: string): number {
  const length = key.length;
  if (length >= 24) return StringCodec.write(roomFor(writer, position, StringCodec.maxSize(key)), position, key);
  const bytes = roomFor(writer, position, length + 1);
  for (let index = 0; index < length; index++) {
    const unit = key.charCodeAt(index);
    if (unit >= 0x80) return StringCodec.write(roomFor(writer, position, StringCodec.maxSize(key)), position, key);
    bytes[position + 1 + index] = unit;
  }
  bytes[position] = MajorBits.Text | length;
  return position + 1 + length;
}

/** Own enumerable string-keyed properties with defined values, in order. */
export function objectEntries(object: ValueObject): Array<readonly [string, Value]> {
  const checkOwn = objectPrototypeHasEnumerableKeys();
  const entries: Array<readonly [string, Value]> = [];
  for (const key in object) {
    if (checkOwn && !Object.hasOwn(object, key)) continue;
    const value = object[key];
    if (value !== undefined) entries.push([key, value]);
  }
  return entries;
}

// ---------------------------------------------------------------- Map

export function measureMap(map: ReadonlyMap<Value, Value>, upper: boolean, depth: number, measureValue: MeasureValue, shortestFloats: boolean): number {
  let total = argumentSize(map.size);
  for (const [key, value] of map) {
    total += measureValue(key, upper, depth, shortestFloats) + measureValue(value, upper, depth, shortestFloats);
  }
  if (!Number.isSafeInteger(total)) fail('invalid-length', 0, 'Encoded map size exceeds safe integer range');
  return total;
}

/** Any key types, in insertion order; undefined values are written (f7).
 * A local cursor with inline paths for the common COSE shapes (integer and
 * short text keys, byte-string and scalar values); anything else goes through
 * the dispatcher. */
export function writeMap(writer: Writer, map: ReadonlyMap<Value, Value>, depth: number, writeValue: WriteValue): void {
  let position = writeArgument(roomFor(writer, writer.position, 9), writer.position, MajorBits.Map, map.size);
  for (const [key, value] of map) {
    position = writeMapItem(writer, position, key, depth, writeValue);
    position = writeMapItem(writer, position, value, depth, writeValue);
  }
  writer.position = position;
}

function writeMapItem(writer: Writer, position: number, item: Value, depth: number, writeValue: WriteValue): number {
  if (typeof item === 'number') return NumberCodec.write(roomFor(writer, position, 9), position, item);
  if (typeof item === 'string') return writeKey(writer, position, item);
  if (item instanceof Uint8Array) {
    return TypedArrayCodec.writeByteString(roomFor(writer, position, 9 + item.length), position, item);
  }
  if (Simple.isSimple(item)) {
    roomFor(writer, position, 1)[position] = Simple.tokenOf(item);
    return position + 1;
  }
  writer.position = position;
  writeValue(writer, item, depth);
  return writer.position;
}

// ---------------------------------------------------------------- deterministic

/** Lexicographic byte order; a prefix sorts first. */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function encodeKey(key: Value, depth: number, writeValue: WriteValue): Uint8Array {
  const keyWriter = createWriter(new Uint8Array(32), 0, true);
  writeValue(keyWriter, key, depth);
  return keyWriter.bytes.subarray(0, keyWriter.position);
}

/** Entries in the given order, each key and value through writeValue. */
export function writeEntries(writer: Writer, entries: ReadonlyArray<readonly [Value, Value]>, depth: number, writeValue: WriteValue): void {
  ensure(writer, 9);
  writer.position = writeArgument(writer.bytes, writer.position, MajorBits.Map, entries.length);
  for (const [key, value] of entries) {
    writeValue(writer, key, depth);
    writeValue(writer, value, depth);
  }
}

/** Indexes of the byte arrays in byte order, and whether any two are equal. */
function sortEncodedKeys(encodedKeys: readonly Uint8Array[]): { readonly order: number[]; readonly hasEqual: boolean } {
  const order = encodedKeys.map((_, index) => index).toSorted((left, right) => compareBytes(encodedKeys[left], encodedKeys[right]));
  const hasEqual = order.some((keyIndex, position) => position > 0 && compareBytes(encodedKeys[order[position - 1]], encodedKeys[keyIndex]) === 0);
  return { order, hasEqual };
}

/** RFC 8949 §4.2.1: entries ordered by the bytes of their encoded keys.
 * Keys that encode identically are duplicates, which deterministic CBOR forbids. */
export function writeSortedEntries(writer: Writer, entries: ReadonlyArray<readonly [Value, Value]>, depth: number, writeValue: WriteValue): void {
  const encodedKeys = entries.map(([key]) => encodeKey(key, depth, writeValue));
  const { order, hasEqual } = sortEncodedKeys(encodedKeys);
  if (hasEqual) fail('duplicate-key', writer.position, 'Duplicate map key');
  ensure(writer, 9);
  writer.position = writeArgument(writer.bytes, writer.position, MajorBits.Map, entries.length);
  for (const index of order) {
    const key = encodedKeys[index];
    ensure(writer, key.length);
    writer.bytes.set(key, writer.position);
    writer.position += key.length;
    writeValue(writer, entries[index][1], depth);
  }
}

// ---------------------------------------------------------------- decoding

/** A definite-length text key: repeated keys come from the key cache. */
function readTextKey(state: DecodeState, token: number): string {
  const bytes = state.bytes;
  const keyOffset = state.position;
  const additionalInfo = token & 31;
  const byteLength = readArgumentValue(bytes, keyOffset + 1, additionalInfo);
  const start = argumentEnd(keyOffset + 1, additionalInfo);
  readable(bytes, start, byteLength);
  state.position = start + byteLength;
  // One ASCII character: V8 keeps these strings in a built-in table, so
  // building one is cheaper than a cache lookup.
  if (byteLength === 1 && bytes[start] < 0x80) return String.fromCharCode(bytes[start]);
  const cached = KeyCache.lookup(bytes, start, byteLength);
  if (cached !== undefined) return cached;
  const key = StringCodec.readPayload(bytes, start, byteLength, state.options, state);
  if (state.options?.invalidUtf8 !== 'replace') KeyCache.remember(bytes, start, byteLength, key);
  return key;
}

/** Major type 0 or 1 (an integer) or 3 (text, definite or in chunks). */
const isIntegerOrText = (token: number): boolean => token >>> 5 <= Major.Negative || token >>> 5 === Major.Text;

const isDefiniteText = (token: number): boolean => token >>> 5 === Major.Text && (token & 31) !== Info.Indefinite;

/** Small unsigned integers are the most common map value: decode them here
 * rather than through the dispatcher (as the array loop does). */
function readEntryValue(state: DecodeState, readValue: ReadValue): Value {
  readable(state.bytes, state.position, 1);
  const token = state.bytes[state.position];
  if (token < 24) {
    state.position++;
    return token;
  }
  return readValue(state);
}

/** Whether another entry follows; consumes the break of an indefinite map.
 * Loops test `index < entryCount` themselves first: per-entry calls here,
 * when V8 did not inline them, made small-object decoding bimodal (+40%). */
function moreEntries(state: DecodeState, index: number, entryCount: number, headerOffset: number): boolean {
  if (entryCount !== UNTIL_BREAK) return index < entryCount;
  readable(state.bytes, state.position, 1);
  if (state.bytes[state.position] === Token.Break) {
    state.position++;
    return false;
  }
  if (index >= state.maxMapEntries) fail('map-limit', headerOffset, 'Map exceeds maxMapEntries');
  return true;
}

/** A duplicate key overwrites an earlier one, leaving fewer distinct keys
 * than entries. Counting once is ~4x cheaper than checking each key. */
function checkDuplicates(state: DecodeState, distinctKeys: number, entries: number, headerOffset: number): void {
  if (state.rejectDuplicateKeys && distinctKeys !== entries) fail('duplicate-key', headerOffset, 'Duplicate map key');
}

/** Up to this many, byte arrays are compared pairwise, with no allocation;
 * beyond it they are sorted, so a hostile map can't make the check quadratic. */
const PAIRWISE_LIMIT = 16;

function hasEqualBytes(arrays: readonly Uint8Array[]): boolean {
  if (arrays.length > PAIRWISE_LIMIT) return sortEncodedKeys(arrays).hasEqual;
  for (let later = 1; later < arrays.length; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      if (arrays[earlier].length === arrays[later].length && compareBytes(arrays[earlier], arrays[later]) === 0) return true;
    }
  }
  return false;
}

/** A string that two keys share exactly when they are equal CBOR values:
 * integers equal whether number or bigint, maps and objects equal whatever
 * their entry order. Each part delimits itself, so the parts can't run into
 * each other. Built from the decoded value, so decoding needs no encoder. */
function keyFingerprint(value: Value): string {
  switch (typeof value) {
    case 'string': return 's' + JSON.stringify(value);
    case 'bigint': return 'i' + value.toString();
    case 'number':
      return Number.isSafeInteger(value) && !Object.is(value, -0) ? 'i' + String(value) : 'f' + (Object.is(value, -0) ? '-0' : String(value));
    case 'boolean': return value ? 'T' : 'F';
    case 'undefined': return 'U';
  }
  if (value === null) return 'N';
  if (value instanceof Uint8Array) return 'b' + bytesFingerprint(value);
  if (ArrayBuffer.isView(value)) {
    return 'y' + value.constructor.name + bytesFingerprint(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return '[' + value.map(keyFingerprint).join(',') + ']';
  if (value instanceof Date) return 'd' + String(value.getTime());
  if (value instanceof Map) return entriesFingerprint(Array.from(value));
  if (Tag.isTagged(value)) return 't' + String(value.tag) + '(' + keyFingerprint(value.value) + ')';
  if (Simple.isSimpleValue(value)) return 'x' + String(value.simple);
  return entriesFingerprint(Object.entries(value));
}

function entriesFingerprint(entries: ReadonlyArray<readonly [Value, Value]>): string {
  return '{' + entries.map(([key, item]) => keyFingerprint(key) + '=' + keyFingerprint(item)).toSorted().join(',') + '}';
}

function bytesFingerprint(bytes: Uint8Array): string {
  let text = String(bytes.length) + ':';
  for (const byte of bytes) text += (byte < 16 ? '0' : '') + byte.toString(16);
  return text;
}

/** A Map tells primitive keys apart by value but object keys (byte strings,
 * arrays, maps, tags, dates) only by identity, so two equal byte strings are
 * two entries. This runs only for maps that have object keys. Byte strings,
 * the common case, are equal when their bytes are; the rest are compared by
 * fingerprint. */
function checkObjectKeys(state: DecodeState, objectKeys: readonly Value[], headerOffset: number): void {
  if (!state.rejectDuplicateKeys || objectKeys.length < 2) return;
  const byteStrings: Uint8Array[] = [];
  const fingerprints = new Set<string>();
  let otherKeys = 0;
  for (const key of objectKeys) {
    if (key instanceof Uint8Array) {
      byteStrings.push(key);
    } else {
      fingerprints.add(keyFingerprint(key));
      otherKeys++;
    }
  }
  if (hasEqualBytes(byteStrings) || fingerprints.size !== otherKeys) fail('duplicate-key', headerOffset, 'Duplicate map key');
}

/** Any key but definite text, which is always allowed: checked here, off
 * the text-key path, against mapKeys: 'integer-or-text'. */
function readOtherKey(state: DecodeState, keyToken: number, readValue: ReadValue): Value {
  if (state.integerOrTextKeys && !isIntegerOrText(keyToken)) {
    fail('unsupported-type', state.position, 'Map keys must be integers or text (mapKeys: "integer-or-text")');
  }
  return readValue(state);
}

/** With duplicateKeys: 'last-wins', an object key equal to an earlier one
 * becomes that earlier key, so its value replaces the earlier value in
 * place, as a repeated primitive key's does. */
function earlierEqualKey(keysByFingerprint: Map<string, Value>, key: Value): Value {
  const fingerprint = keyFingerprint(key);
  const earlier = keysByFingerprint.get(fingerprint);
  if (earlier !== undefined) return earlier;
  keysByFingerprint.set(fingerprint, key);
  return key;
}

function readIntoMap(state: DecodeState, map: Map<Value, Value>, index: number, entryCount: number, headerOffset: number, readValue: ReadValue): Map<Value, Value> {
  const bytes = state.bytes;
  let objectKeys: Value[] | undefined;
  let keysByFingerprint: Map<string, Value> | undefined;
  for (; moreEntries(state, index, entryCount, headerOffset); index++) {
    readable(bytes, state.position, 1);
    const keyToken = bytes[state.position];
    let key = isDefiniteText(keyToken) ? readTextKey(state, keyToken) : readOtherKey(state, keyToken, readValue);
    if (typeof key === 'object' && key !== null) {
      if (state.rejectDuplicateKeys) (objectKeys ??= []).push(key);
      else key = earlierEqualKey(keysByFingerprint ??= new Map(), key);
    }
    map.set(key, readEntryValue(state, readValue));
  }
  checkDuplicates(state, map.size, index, headerOffset);
  if (objectKeys !== undefined) checkObjectKeys(state, objectKeys, headerOffset);
  return map;
}

/** 'auto' mode met a non-text key: move the entries so far into a Map and continue there. */
function continueAsMap(state: DecodeState, object: Record<string, Value>, index: number, entryCount: number, headerOffset: number, readValue: ReadValue): Map<Value, Value> {
  if (index > 1) checkDuplicates(state, Object.keys(object).length, index, headerOffset);
  return readIntoMap(state, new Map<Value, Value>(Object.entries(object)), index, entryCount, headerOffset, readValue);
}

/** state.position is immediately after the map's initial byte. Text keys build
 * a plain object; Map is used in 'map' mode, or in 'auto' mode from the first
 * non-text key. The object loop stays in this function: one call deeper, it
 * was not reliably inlined and small-object decoding became bimodal. */
export function read(state: DecodeState, additionalInfo: number, readValue: ReadValue): Value {
  const bytes = state.bytes;
  const headerOffset = state.position - 1;
  const indefinite = additionalInfo === Info.Indefinite;
  let entryCount = UNTIL_BREAK;
  if (indefinite) {
    enterContainer(state, 0, headerOffset);
  } else {
    entryCount = readArgumentValue(bytes, state.position, additionalInfo);
    state.position = argumentEnd(state.position, additionalInfo);
    if (entryCount > state.maxMapEntries) fail('map-limit', headerOffset, 'Map exceeds maxMapEntries');
    // Each entry is at least a key byte and a value byte.
    readable(bytes, state.position, 2 * entryCount);
    enterContainer(state, 2 * entryCount, headerOffset);
  }
  if (state.mapMode === 'map') {
    const map = readIntoMap(state, new Map(), 0, entryCount, headerOffset, readValue);
    leaveContainer(state);
    return map;
  }
  const object: Record<string, Value> = {};
  let index = 0;
  for (; indefinite ? moreEntries(state, index, entryCount, headerOffset) : index < entryCount; index++) {
    readable(bytes, state.position, 1);
    const keyToken = bytes[state.position];
    let key: string;
    if (isDefiniteText(keyToken)) {
      key = readTextKey(state, keyToken);
    } else if (keyToken >>> 5 === Major.Text) {
      key = readValue(state) as string; // chunked text
    } else if (state.mapMode === 'object') {
      return fail('unsupported-type', state.position, 'Map keys must be text strings (decode with maps: "auto" or "map")');
    } else {
      const map = continueAsMap(state, object, index, entryCount, headerOffset, readValue);
      leaveContainer(state);
      return map;
    }
    // Small unsigned integers are the most common value: decode them inline.
    readable(bytes, state.position, 1);
    const valueToken = bytes[state.position];
    let value: Value;
    if (valueToken < 24) {
      value = valueToken;
      state.position++;
    } else {
      value = readValue(state);
    }
    if (key === '__proto__') {
      // A data property, not the prototype setter: no pollution, no renaming.
      Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
    } else {
      object[key] = value;
    }
  }
  if (index > 1) checkDuplicates(state, Object.keys(object).length, index, headerOffset);
  leaveContainer(state);
  return object;
}
