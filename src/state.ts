import { fail } from './error.js';
import type { ErrorCode } from './error.js';
import type { DecodeOptions, Value } from './types.js';

const DEFAULT_MAX_ARRAY_LENGTH = 1_000_000;
const DEFAULT_MAX_MAP_ENTRIES = 1_000_000;
const DEFAULT_MAX_DEPTH = 128;

/** Explicit state for decoding one container tree. Created per decode call
 * (only when the value is an array or map) and passed down; nothing is
 * shared between calls. */
/** The current text window (see string.ts): part of the input, masked to
 * ASCII and decoded with one TextDecoder call, that medium-length ASCII
 * strings are sliced from. Empty until the first such string. */
export interface TextWindow {
  windowStart: number;
  windowText: string;
}

export interface DecodeState extends TextWindow {
  readonly bytes: Uint8Array;
  /** Cursor: the next unread byte. */
  position: number;
  depth: number;
  /** Items the remaining containers may still declare. Every item takes at
   * least one input byte, so a valid message never exceeds its own length;
   * this stops nested headers from preallocating O(bytes × depth). */
  itemBudget: number;
  readonly options: DecodeOptions | undefined;
  /** Created at most once per decode, on the first float64 array element of
   * an input over 64 bytes (already off-heap, so a DataView is cheap there). */
  floatView: DataView | undefined;
  /** Byte strings copied during this decode (see arena.ts). */
  arena: Uint8Array | undefined;
  arenaUsed: number;
  /** Byte strings go into the arena ('copy', the default). */
  readonly useArena: boolean;
  readonly maxArrayLength: number;
  readonly maxMapEntries: number;
  readonly maxDepth: number;
  readonly rejectDuplicateKeys: boolean;
  readonly mapMode: 'auto' | 'object' | 'map';
}

function validLimit(value: number | undefined, fallback: number, code: ErrorCode, name: string, offset: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) fail(code, offset, `Invalid ${name}`);
  return value;
}

export interface ContainerLimits {
  readonly maxArrayLength: number;
  readonly maxMapEntries: number;
  readonly maxDepth: number;
}

/** Validated limits from options; shared by the decoder and the sequence scanner. */
export function containerLimits(options: DecodeOptions | undefined, offset: number): ContainerLimits {
  return {
    maxArrayLength: Math.min(
      validLimit(options?.maxArrayLength, DEFAULT_MAX_ARRAY_LENGTH, 'array-limit', 'maxArrayLength', offset),
      0xffffffff),
    maxMapEntries: validLimit(options?.maxMapEntries, DEFAULT_MAX_MAP_ENTRIES, 'map-limit', 'maxMapEntries', offset),
    maxDepth: validLimit(options?.maxDepth, DEFAULT_MAX_DEPTH, 'depth-limit', 'maxDepth', offset),
  };
}

/** position is immediately after the container's initial byte. */
export function createState(bytes: Uint8Array, position: number, options: DecodeOptions | undefined): DecodeState {
  const headerOffset = position - 1;
  const limits = containerLimits(options, headerOffset);
  return {
    bytes,
    position,
    depth: 0,
    itemBudget: bytes.length - headerOffset,
    options,
    floatView: undefined,
    arena: undefined,
    arenaUsed: 0,
    windowStart: 0,
    windowText: '',
    useArena: options?.binaryOwnership === undefined || options.binaryOwnership === 'copy',
    maxArrayLength: limits.maxArrayLength,
    maxMapEntries: limits.maxMapEntries,
    maxDepth: limits.maxDepth,
    rejectDuplicateKeys: options?.duplicateKeys !== 'last-wins',
    mapMode: options?.maps ?? 'auto',
  };
}

/** Enter a container whose initial byte is at headerOffset and which declares
 * itemCount nested items. */
export function enterContainer(state: DecodeState, itemCount: number, headerOffset: number): void {
  if (state.depth >= state.maxDepth) fail('depth-limit', headerOffset, 'Nesting exceeds maxDepth');
  if (itemCount > state.itemBudget) fail('truncated', headerOffset, 'Declared items exceed the remaining input');
  state.depth++;
  state.itemBudget -= itemCount;
}

export function leaveContainer(state: DecodeState): void {
  state.depth--;
}

/** The item dispatcher, passed to container codecs so they need not import it. */
export type ReadValue = (state: DecodeState) => Value;
