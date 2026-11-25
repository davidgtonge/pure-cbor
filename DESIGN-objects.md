# Design proposal: objects and nesting (cbor-fp 0.3)

Status: **implemented in 0.3.0** with the recommended defaults: plain objects only, `undefined` properties omitted, duplicates rejected, `maxDepth` 128, a module-level key cache. Measured results are in BENCHMARK.md.

Differences from this proposal, each made after measuring:

- **Object enumeration** uses `for…in` (allocation-free, about 3× faster) instead of `Object.keys`/`Object.values`, adding an own-property check only when `Object.prototype` has enumerable properties. The map writer is therefore single-pass: it reserves a 1-byte header and patches it at the end, shifting entries for maps of 24 or more.
- **Duplicate keys** are detected by comparing the object's key count with the entry count once per map (about 4× cheaper than `Object.hasOwn` per key). The `duplicate-key` error therefore points at the map header, not the repeated key.
- **One-character ASCII keys** bypass the key cache, because V8 already interns them.
- **Array and map loops** write scalars inline rather than through a shared helper; V8 declined to inline the helper there, which cost 10–20%.
- **Small-integer map values** are decoded inline in the map loop. This removed a bimodal slow mode (±18% between processes) on small-object workloads.

The original proposal follows unchanged.

## 1. Goals

- Plain JS objects ↔ standard CBOR maps (major type 5), with arbitrary nesting of objects and arrays.
- Faster than cbor-x in its **standard** mode (`useRecords: false`) on encode and decode, measured per process, owned output, fresh input.
- Keep what makes this library what it is: standard CBOR only, no `new Function`/codegen (CSP-safe), no hidden global state, typed errors, atomic capacity errors, hostile-input limits.

Non-goals for 0.3: cbor-x "records"/structures (non-standard wire format), JS `Map`, `Date`, class instances, `undefined`, canonical/deterministic key sorting, streaming.

## 2. How cbor-x does objects (findings)

Read from `cbor-x` `decode.js`/`encode.js` and measured on this machine (Node 22.19, pure JS, per-process medians).

| Mode | How it encodes | How it decodes | Wire |
| --- | --- | --- | --- |
| Standard (`useRecords: false`) | `for…in` + `hasOwnProperty`; **always** a 3-byte map16 header, back-patched (non-preferred). `variableMapSize: true` gives preferred headers via `Object.keys`/`Object.values`. Keys go through generic `encode()`. | `object[safeKey(read())] = read()` on `{}`. Keys go through the generic string reader. A `readKey()` key cache exists in the source but is **never called**. | Standard CBOR maps |
| Records (default for `new Encoder()`) | Tracks a transition tree of key sequences; writes a structure definition once, then each object as an array of values under a private tag. | After a few reads, **compiles a reader with `new Function`** that returns an object literal. | Non-standard; both ends must be cbor-x |

Safety behaviour: `safeKey` **renames** `__proto__` to `__proto_` and coerces number/boolean/null keys to strings. There's no depth limit (deep input → `RangeError: Maximum call stack`). Encode has no cycle detection unless `structuredClone` is on. Decode checks `count > remaining/2` and an array allocation budget.

Measured (ns, lower is better):

| Workload | std encode (pooled) | std encode (owned) | records encode | std decode | records decode | bytes std / records / JSON |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 row `{id,name,active,score,email,tags}` | 217 | 294 | 330 | 287 | 336 | 59 / 64 / 81 |
| 100 rows | 17,622 | 18,368 | 12,821 | 29,447 | **8,587** | 6,068 / 3,004 / 8,421 |
| nested config (2 levels, 20 items) | 1,136 | 1,401 | 1,386 | 1,331 | 1,445 | 268 / 226 / 407 |

Where the time goes when decoding objects (6-key object, construction only):

| Key source | ns/object |
| --- | ---: |
| fresh key strings (what cbor-x standard does) | 178 |
| **cached, already-internalized key strings** | **78** |
| constant keys (lower bound) | 47 |
| template `{...t}` then assign | 71 |

A new key string has to be internalized by V8 every time it's used as a property name. Returning an already-internalized string from a small cache saves more than half of the object-construction cost. This is the main lever, and it needs no codegen.

## 3. Data model

```ts
export type Scalar = number | string | boolean | null;
export type Value = Scalar | TypedArray | readonly Value[] | ValueObject;
export interface ValueObject { readonly [key: string]: Value }
```

Decode returns plain mutable objects and arrays (the readonly modifiers are input-side only).

| Topic | Proposal |
| --- | --- |
| Which objects encode | Objects whose prototype is `Object.prototype` or `null`. Others (`Date`, `Map`, `Set`, class instances, boxed primitives) → `unsupported-type`. **(decide)** Alternative: accept any non-special object's own enumerable props, like JSON. Recommended: plain only, because it's explicit and avoids silently dropping class semantics. |
| Which keys | Own enumerable **string** keys in `Object.keys` order. Symbol keys are ignored (as in JSON). |
| `undefined` property values | **(decide)** Recommended: **omit the property** (JSON parity, common with optional TS fields). Alternative: throw `unsupported-type`. |
| Header | Preferred (smallest) map header from the exact entry count. Smaller than cbor-x's default map16 (57 vs 59 bytes for one row). |
| Key order | Insertion order (`Object.keys`), not sorted. Canonical sorting is a possible later option. |
| Wire keys on decode | Text-string keys only; any other key type → `unsupported-type`. (cbor-x coerces numbers/bools/null to strings; we'd rather not guess.) |
| Duplicate keys on decode | **(decide)** Recommended: reject with a new code `duplicate-key` (RFC 8949 calls such maps invalid). Cost is one `Object.hasOwn` per key, to be measured; option `duplicateKeys: 'reject' \| 'last-wins'`. |
| `__proto__` key | Decoded **faithfully** as an own data property via `Object.defineProperty` (only on that rare key), so there's no prototype pollution and no renaming. Encode includes it if it's an own enumerable property. |
| Nested arrays | Allowed. Arrays may contain any `Value`. The existing scalar fast loop stays the hot path; only container, typed-array and tag tokens recurse. |

## 4. Limits and hostile input

| Limit | Default | Behaviour |
| --- | --- | --- |
| `maxDepth` (new) | 128 | Encode and decode. Exceeding → new code `depth-limit`. Also turns encode **cycles** into a typed error with no `WeakSet` cost. **(decide)** the default. |
| `maxArrayLength` | 1,000,000 | Unchanged, per array. |
| `maxMapEntries` (new) | 1,000,000 | Per map; checked against `remaining / 2` before allocating. |
| Allocation budget (new, internal) | input byte length | The sum of declared container lengths across the whole decode must stay ≤ input bytes. This stops nested headers from preallocating O(bytes × depth) (the same issue cbor-x added a budget for). |

All limit and validation failures stay `CborError`s with offsets, so `tryDecode` keeps its contract.

## 5. Decode architecture

Today, scalar readers take `(bytes, offset)` and containers return `[value, next]`. For recursion I propose **one small per-call state record**, created once per `decode()`/`read()` call and passed explicitly (not module-global, so there's still no hidden state):

```ts
interface DecodeState {
  readonly b: Uint8Array;
  p: number;              // cursor
  depth: number;
  budget: number;         // remaining allocation budget
  readonly options: DecodeOptions | undefined;
}
```

- Scalar primitives (`header`, `number`, `string`, `simple`, `typed-array`) stay pure `(b, offset)` functions, unchanged.
- `array.ts` and a new `map.ts` take a `DecodeState` and call a single `readValue(state)` dispatcher in `codec.ts` for nested items.
- To keep the module graph acyclic, the dispatcher is **passed in** (`readValue` parameter) rather than imported by `array.ts`/`map.ts`.
- Public `read()` still returns `[value, nextOffset]` (one tuple per call, as today). `readWhole`/`decode` return the value directly.

Map decode loop (sketch):

```ts
const obj: Record<string, Value> = {};
for (let i = 0; i < count; i++) {
  const key = readKey(state);              // text only, uses the key cache
  const value = readValue(state);
  if (key === '__proto__') defineOwn(obj, key, value);
  else if (rejectDuplicates && Object.hasOwn(obj, key)) fail('duplicate-key', …);
  else obj[key] = value;
}
```

**Key cache** (`keys.ts`): a fixed-size table (e.g. 512 entries) indexed by a hash of length + first/last bytes, holding `{ bytes, string }` for ASCII keys of 1–32 bytes. A hit is confirmed by comparing bytes, so a collision can't return a wrong key. A miss decodes normally and replaces the slot. It holds only key text that was seen before, never values. It's module-level like the existing `TextDecoder`s. **(decide)** module-level shared cache (recommended: simplest, best hit rate) vs. opt-in per-`createDecoder()` closure.

## 6. Encode architecture

- **Owned `encode()`**: single pass into the existing staging buffer, made **growable**. Each item calls `ensure(writer, shallowMaxSize(item))` before writing (O(1) for numbers, simple values, strings and typed arrays). Containers write their header from the known count (`values.length`, or `Object.keys(o).length` after filtering out `undefined` values). Then the used bytes are copied out once, as today. There's no full sizing pass.
- **`encodeInto(value, dest)` / `write(binary, …)`**: keep the guarantee that a capacity error never partially writes. A deep upper-bound measure runs first, and only if the bound exceeds the free space does an exact measure run, as arrays do today.
- **Slab encoder**: encode into staging (single pass), then copy into the slab when it fits under the pooling threshold. One extra memcpy per item, but no double traversal of objects.
- Keys are written with the existing string writer (short ASCII loop). A key **encode** cache is not planned; I'd add it only if a benchmark shows it beats writing 3–10 ASCII bytes.

## 7. API changes

- `Value` type widened (objects, nested arrays). Additive for callers.
- New `DecodeOptions`: `maxDepth`, `maxMapEntries`, `duplicateKeys`.
- New `EncodeOptions`? Only `maxDepth` (for cycle protection) would need one. I'd keep it as a fixed internal default and add an options object later if asked.
- New error codes: `depth-limit`, `duplicate-key`, `map-limit`.
- Version → **0.3.0**. This also covers the earlier breaking changes: the integer wire format and `Binary` losing `view`.

## 8. Targets and how they'll be measured

Same harness style as now: each workload in its own process, median of 7, cbor-x pure JS, owned output, fresh and reused inputs.

| Workload | cbor-x std | Target |
| --- | ---: | --- |
| 1 row decode | 287 ns | ≤ 200 ns |
| 100 rows decode | 29.4 µs | ≤ 15 µs (beat std by ~2×) |
| 1 row encode (owned) | 294 ns | ≤ 200 ns |
| 100 rows encode (owned) | 18.4 µs | ≤ 15 µs |
| nested config, both directions | 1.1–1.4 µs | ≤ cbor-x |

Honest expectation: **cbor-x records-mode decode (8.6 µs for 100 rows) will probably stay faster** than any standard-CBOR decoder without codegen. Its wire output is also half the size. I'll report it in the benchmarks rather than hide it.

## 9. Tests

- Golden vectors for maps (empty, 23/24/256 entries, nested, `__proto__`, Unicode keys).
- Differential fuzz against cbor-x standard mode in both directions on random nested `Value` trees (seeded).
- Hostile input: deep nesting at and over `maxDepth`, huge declared counts, nested preallocation bombs, duplicate keys, non-text keys, truncated maps — every case must give a `CborError` and never a `RangeError`.
- Encode: cycles → `depth-limit`. Non-plain objects → `unsupported-type`. `undefined` handling per the decision. Capacity errors don't touch the destination.
- The existing 27 tests must pass unchanged, apart from tests that asserted objects/nesting were unsupported.

## 10. Implementation plan

1. **Refactor only**: add `DecodeState`, a growable staging writer, and nested arrays (no objects yet). Gate: all current benchmarks within noise of today.
2. **Objects**: `map.ts`, the key cache, limits, error codes, tests and fuzz.
3. **Bench and docs**: object workloads in `bench.mjs` (per-process), a rewritten `BENCHMARK.md`, README, version 0.3.0.

Each phase lands with tests passing and before/after numbers.
