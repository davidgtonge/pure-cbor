# Changelog

## 1.0.1

No code changes. The first release built and published by GitHub Actions through npm trusted publishing, so it carries provenance: a signed link from the package on npm to the commit and workflow run that built it.

## 1.0.0

First public release, renamed from cbor-fp to pure-cbor. The API is now covered by semver.

- Named wire constants (`Major`, `MajorBits`, `Info`, `Token`) shared by every module; strict compiler checks and oxlint clean.
- Fix: `encodeStream` dropped the `floats` and `deterministic` options.
- Requires Node 22 or later (tested on Node 22, 24 and 26, and Deno).

## 0.6.0

- Cheaper default byte-string copies. Byte strings over 64 bytes from one decode are copied into a single per-decode arena instead of one allocation each: about 2× faster on COSE and WebAuthn messages, which are mostly keys, signatures and certificates. Results are still independent of the input; byte strings from one decode may now share a backing buffer. `binaryOwnership: 'copy-separate'` restores one exact buffer per byte string.
- Faster encoding of `Map` (inline paths for integer and short text keys, byte strings and scalars) and of byte strings everywhere: COSE_Key encoding is 17% faster and `Sig_structure` 32% faster.

## 0.5.0

- The whole CBOR data model: tags (`Tagged`, with dates, bignums and custom decoders), `undefined` and all simple values, `BigInt`, `Date`, `Map` with any keys, and indefinite-length items on decode. Every example in RFC 8949 Appendix A decodes.
- Opt-in `floats: 'shortest'` (RFC 8949 §4.1 preferred floats) and `deterministic: true` (core deterministic encoding, §4.2.1). On public data, deterministic output matches cborg's canonical encoding byte for byte.
- Behaviour changes:
  - 64-bit integers beyond 2^53 decode as `BigInt` instead of erroring.
  - Maps with non-text keys decode as `Map` (`maps: 'object'` restores the error).
  - Unknown tags decode as `Tagged` instead of erroring.
  - `undefined` and holes in arrays encode as `f7`.

## 0.4.0

- Streaming: CBOR sequences (RFC 8742) over Web Streams and async iterators, plus an environment-free incremental core. See [Streaming](README.md#streaming).

## 0.3.0

- Plain objects as CBOR maps, and arbitrary nesting of arrays and objects.
- `false`, `true` and `null`.
- Every safe integer encodes as a CBOR integer (previously above 2^32 it was a float).
- Limits for hostile input: depth, map size, and a total allocation budget.
- Faster small values throughout. Measured per process against cbor-x and cborg, including on public data other libraries benchmark with, in [BENCHMARK.md](BENCHMARK.md).

### Breaking changes from 0.2.0

- `Binary` no longer has a `view` (DataView) field.
- Integers from 2^32 to 2^53 − 1 now go on the wire as integers instead of floats.
- `maxEncodedSize`/`encodedSize`/`encode` now accept and size nested values and objects.
