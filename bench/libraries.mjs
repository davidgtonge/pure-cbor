// Comparison libraries for bench.mjs, each behind the same small adapter:
//   encode(value) -> an independently owned encoding (pooled outputs are copied,
//                    as pure-cbor's encode() is owned);
//   decode(input) -> the decoded value, from that library's own encoding;
//   fresh(input)  -> a fresh copy of the input, for "just received" decoding;
//   prepare(value)  -> the library's native form of a workload (untimed);
//   normalize(value) -> back to plain objects, for checking round trips.
// Libraries that are not installed are skipped. Install them with:
//   npm install --no-save --package-lock=false cbor-x cborg @levischuck/tiny-cbor cbor cbor2 cbor-js msgpackr @msgpack/msgpack
// cbor-x and msgpackr run pure JS (their optional native string extraction is
// disabled) so all libraries are compared as JavaScript.

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = 'true';
process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED = 'true';

async function optional(name) {
  try {
    return await import(name);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

const identity = value => value;
const copyBytes = bytes => bytes.slice();

/** Plain objects to Map, recursively (for libraries whose maps are Map only). */
function objectsToMaps(value) {
  if (Array.isArray(value)) return value.map(objectsToMaps);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return new Map(Object.entries(value).map(([key, entry]) => [key, objectsToMaps(entry)]));
  }
  return value;
}

/** Map back to plain objects, recursively. */
function mapsToObjects(value) {
  if (Array.isArray(value)) return value.map(mapsToObjects);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, entry]) => [key, mapsToObjects(entry)]));
  return value;
}

export async function loadLibraries() {
  const libraries = [];
  const cborX = await optional('cbor-x');
  if (cborX) {
    // Standard CBOR mode (no records extension); 64-bit integers as numbers.
    const encoder = new cborX.Encoder({ useRecords: false, bundleStrings: false, structuredClone: false });
    const decoder = new cborX.Decoder({ useRecords: false, copyBuffers: true, int64AsNumber: true });
    libraries.push({ name: 'cbor-x', format: 'CBOR', encode: value => Uint8Array.from(encoder.encode(value)), decode: bytes => decoder.decode(bytes) });
  }
  const cborg = await optional('cborg');
  if (cborg) {
    // Default options: sorted keys and shortest floats (deterministic output).
    libraries.push({ name: 'cborg', format: 'CBOR', encode: cborg.encode, decode: cborg.decode });
  }
  const tiny = await optional('@levischuck/tiny-cbor');
  if (tiny) {
    // Maps are JS Map only, in both directions; no typed arrays.
    libraries.push({ name: 'tiny-cbor', format: 'CBOR', encode: tiny.encodeCBOR, decode: tiny.decodeCBOR,
      prepare: objectsToMaps, normalize: mapsToObjects });
  }
  const nodeCbor = (await optional('cbor'))?.default;
  if (nodeCbor) {
    // Shortest floats by default; encode returns a view into a shared pool.
    libraries.push({ name: 'cbor (node-cbor)', format: 'CBOR', encode: value => Uint8Array.from(nodeCbor.encode(value)),
      decode: bytes => nodeCbor.decodeFirstSync(bytes) });
  }
  const cbor2 = await optional('cbor2');
  if (cbor2) {
    // Shortest floats by default.
    libraries.push({ name: 'cbor2', format: 'CBOR', encode: value => cbor2.encode(value), decode: bytes => cbor2.decode(bytes) });
  }
  const cborJs = (await optional('cbor-js'))?.default;
  if (cborJs) {
    // Encodes to and decodes from ArrayBuffer.
    libraries.push({ name: 'cbor-js', format: 'CBOR', encode: value => cborJs.encode(value), decode: buffer => cborJs.decode(buffer),
      fresh: buffer => buffer.slice(0) });
  }
  const msgpackr = await optional('msgpackr');
  if (msgpackr) {
    // MessagePack, standard mode (no records); pack returns a view into a pool.
    const packr = new msgpackr.Packr({ useRecords: false });
    libraries.push({ name: 'msgpackr', format: 'MessagePack', encode: value => Uint8Array.from(packr.pack(value)), decode: bytes => packr.unpack(bytes) });
  }
  const msgpack = await optional('@msgpack/msgpack');
  if (msgpack) {
    libraries.push({ name: '@msgpack/msgpack', format: 'MessagePack', encode: value => msgpack.encode(value), decode: bytes => msgpack.decode(bytes) });
  }
  return libraries.map(library => ({ prepare: identity, normalize: identity, fresh: copyBytes, ...library }));
}
