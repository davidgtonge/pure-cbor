import type { EncodeOptions, Value } from './types.js';

/** How values are written: fixed per encode call. */
export interface EncodeProfile {
  readonly shortestFloats: boolean;
  readonly sortKeys: boolean;
}

export const DEFAULT_PROFILE: EncodeProfile = Object.freeze({ shortestFloats: false, sortKeys: false });
const SHORTEST_FLOATS: EncodeProfile = Object.freeze({ shortestFloats: true, sortKeys: false });
const DETERMINISTIC: EncodeProfile = Object.freeze({ shortestFloats: true, sortKeys: true });

export function profileOf(options: EncodeOptions | undefined): EncodeProfile {
  if (options === undefined) return DEFAULT_PROFILE;
  if (options.deterministic) return DETERMINISTIC;
  return options.floats === 'shortest' ? SHORTEST_FLOATS : DEFAULT_PROFILE;
}

/** Output for one encode call: bytes plus a cursor. A growable writer (owned
 * encoding into staging memory) reallocates on demand; a fixed writer
 * (caller-owned memory) never grows, and its capacity is checked up front.
 * Encode options are not stored here: they select which write function runs
 * (see writerFor in codec.ts), so the default path never checks them. */
export interface Writer {
  bytes: Uint8Array;
  position: number;
  readonly growable: boolean;
}

export function createWriter(bytes: Uint8Array, position: number, growable: boolean): Writer {
  return { bytes, position, growable };
}

/** Make room for `byteCount` more bytes at the cursor (growable writers only). */
export function ensure(writer: Writer, byteCount: number): void {
  if (byteCount > writer.bytes.length - writer.position && writer.growable) grow(writer, byteCount);
}

/** The writer's bytes, with room for `byteCount` at `position`. For loops that
 * keep the cursor in a local variable; fixed writers were preflighted. */
export function roomFor(writer: Writer, position: number, byteCount: number): Uint8Array {
  if (byteCount > writer.bytes.length - position && writer.growable) {
    writer.position = position;
    grow(writer, byteCount);
  }
  return writer.bytes;
}

function grow(writer: Writer, byteCount: number): void {
  const larger = new Uint8Array(Math.max(2 * writer.bytes.length, writer.position + byteCount, 256));
  larger.set(writer.bytes.subarray(0, writer.position));
  writer.bytes = larger;
}

/** Dispatchers passed to container codecs so they need not import codec.ts.
 * depth is the nesting level of the value's container. */
export type WriteValue = (writer: Writer, value: Value, depth: number) => void;
export type MeasureValue = (value: Value, upper: boolean, depth: number, shortestFloats: boolean) => number;
