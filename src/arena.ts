import type { DecodeState } from './state.js';

// Byte strings copied out of the input during one decode. In V8 every
// Uint8Array over 64 bytes is a separate off-heap allocation (~0.5 µs), and
// COSE/WebAuthn messages are mostly such byte strings (keys, signatures,
// certificates). So larger byte strings are copied into a per-decode arena:
// one allocation, sized to what remains of the input (no larger than 64 KiB
// unless one byte string needs more), filled one after another. Results stay
// independent of the input; byte strings from one decode may share an arena.
// Small byte strings keep their own cheap on-heap copies.

const ON_HEAP_LIMIT = 64;
const MAX_ARENA = 64 * 1024;

/** A copy of bytes[start, start + length). Bounds are already checked. */
export function copyByteString(state: DecodeState, start: number, length: number): Uint8Array {
  const input = state.bytes;
  if (length <= ON_HEAP_LIMIT) return input.slice(start, start + length);
  let arena = state.arena;
  if (arena === undefined || length > arena.length - state.arenaUsed) {
    // Everything still to come lies in the rest of the input, so this size
    // never exceeds it, and a small message gets exactly one arena.
    arena = new Uint8Array(Math.max(length, Math.min(input.length - start, MAX_ARENA)));
    state.arena = arena;
    state.arenaUsed = 0;
  }
  const offset = state.arenaUsed;
  arena.set(input.subarray(start, start + length), offset);
  state.arenaUsed = offset + length;
  return arena.subarray(offset, offset + length);
}
