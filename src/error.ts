export type ErrorCode =
  | 'truncated' | 'capacity' | 'invalid-offset' | 'invalid-header'
  | 'invalid-length' | 'invalid-utf8' | 'integer-overflow'
  | 'array-limit' | 'map-limit' | 'depth-limit' | 'item-limit' | 'duplicate-key'
  | 'unsupported-type' | 'unsupported-tag' | 'invalid-tag-content' | 'trailing-data' | 'invalid-buffer';

/** Error construction is cold-path only; no per-byte Result allocations. */
export class CborError extends Error {
  constructor(readonly code: ErrorCode, readonly offset: number, message: string) {
    super(message);
    this.name = 'CborError';
  }
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CborError };

export function fail(code: ErrorCode, offset: number, message: string): never {
  throw new CborError(code, offset, message);
}
