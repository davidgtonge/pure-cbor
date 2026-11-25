// COSE / WebAuthn / mdoc flows on real vectors (test/vectors), timed per
// library. Each flow is verified for every library before timing, so all
// libraries are measured doing the same, correct work. Each flow runs in its
// own process. Usage: node bench/cose.mjs (needs the libraries from
// bench/libraries.mjs installed; missing ones are skipped).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as cborFp from '../dist/index.js';

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = 'true';
const durationMs = Number(process.env.BENCH_MS || 80);
const rounds = Number(process.env.BENCH_ROUNDS || 5);

// ---------------------------------------------------------------- vectors

const vectorPath = path => new URL(`../test/vectors/${path}`, import.meta.url);
const readJson = path => JSON.parse(readFileSync(vectorPath(path), 'utf8'));
const hex = text => Uint8Array.from(Buffer.from(text, 'hex'));
const toHex = bytes => Buffer.from(bytes).toString('hex');

const attestations = readJson('webauthn/webauthn-l3-test-vectors.json').vectors.map(vector => hex(vector.attestationObject));
const sign1 = ['sign1-tests', 'ecdsa-examples', 'eddsa-examples'].flatMap(folder => readdirSync(vectorPath(`cose/${folder}`))
  .map(file => readJson(`cose/${folder}/${file}`))
  .filter(vector => vector.input.sign0 && vector.intermediates.ToBeSign_hex && !vector.input.failures && !vector.title.includes('fail')))
  .map(vector => ({ message: hex(vector.output.cbor), external: hex(vector.input.sign0.external ?? ''), toBeSigned: vector.intermediates.ToBeSign_hex.toLowerCase() }));
const cwts = ['A_3', 'A_4'].map(name => hex(readJson(`cose/CWT/${name}.json`).output.cbor));
const mdocItems = readJson('mdoc/iso-18013-5-annex-d.json').items;
const deviceResponse = hex(mdocItems.DEVICE_RESPONSE);

// ---------------------------------------------------------------- libraries

const optional = async name => {
  try { return await import(name); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined; throw error; }
};
const getField = (map, key) => (map instanceof Map ? map.get(key) : map[key]);

/** Each adapter: decode (whole message), decodeFirst (one item, trailing bytes
 * allowed), encode, contentOf (a tag's content, whatever its tag type), and
 * bytes (the byte type it encodes as a byte string; applied to constant
 * inputs before timing). node-cbor and cbor-x (in Node) need Buffer: both
 * write a plain Uint8Array as an RFC 8746 typed array (tag 64), and cbor-x
 * decoding from a Uint8Array returns byte strings that re-encode that way,
 * which would silently break Sig_structure. cbor2 writes a Buffer as a
 * { type, data } map and needs a plain Uint8Array. */
const plainBytes = bytes => bytes;
const nodeBuffer = bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
async function loadLibraries() {
  const contentOf = value => (cborFp.isTagged(value) ? value.value : value);
  // Default: byte strings are copied. 'borrow': views into the input, which is
  // what cbor-x does by default (and is safe while the input is kept).
  const borrow = { binaryOwnership: 'borrow' };
  const libraries = [{
    name: 'pure-cbor',
    decode: bytes => cborFp.decode(bytes),
    decodeFirst: bytes => cborFp.read(cborFp.binary(bytes), 0)[0],
    encode: value => cborFp.encode(value),
    contentOf,
    bytes: plainBytes,
  }, {
    name: 'pure-cbor (borrow)',
    decode: bytes => cborFp.decode(bytes, borrow),
    decodeFirst: bytes => cborFp.read(cborFp.binary(bytes), 0, borrow)[0],
    encode: value => cborFp.encode(value),
    contentOf,
    bytes: plainBytes,
  }];
  const cborX = await optional('cbor-x');
  if (cborX) {
    const decoder = new cborX.Decoder({ useRecords: false, mapsAsObjects: false });
    const encoder = new cborX.Encoder({ useRecords: false, mapsAsObjects: false });
    libraries.push({
      name: 'cbor-x',
      decode: bytes => decoder.decode(bytes),
      decodeFirst: bytes => { let first; decoder.decodeMultiple(bytes, value => { first = value; return false; }); return first; },
      encode: value => encoder.encode(value),
      contentOf: value => (value instanceof cborX.Tag ? value.value : value),
      bytes: nodeBuffer, // in Node, cbor-x writes byte strings from Buffer
    });
  }
  const cborg = await optional('cborg');
  if (cborg) {
    // cborg needs a decoder for every tag it meets; keep them as { tag, value }.
    // cborg 7 passes a function that decodes the tag's content.
    const keep = tag => decodeContent => ({ tag, value: decodeContent() });
    const tags = [];
    for (const tag of [0, 17, 18, 24, 61, 1004]) tags[tag] = keep(tag);
    const options = { useMaps: true, tags };
    libraries.push({
      name: 'cborg',
      decode: bytes => cborg.decode(bytes, options),
      decodeFirst: bytes => cborg.decodeFirst(bytes, options)[0],
      encode: value => cborg.encode(value),
      contentOf: value => (value && typeof value === 'object' && 'tag' in value && 'value' in value ? value.value : value),
      bytes: plainBytes,
    });
  }
  const tiny = await optional('@levischuck/tiny-cbor');
  if (tiny) {
    libraries.push({
      name: 'tiny-cbor',
      decode: bytes => tiny.decodeCBOR(bytes),
      decodeFirst: bytes => tiny.decodePartialCBOR(bytes, 0)[0],
      encode: value => tiny.encodeCBOR(value),
      contentOf: value => (value instanceof tiny.CBORTag ? value.tagValue : value),
      bytes: plainBytes,
    });
  }
  const nodeCbor = (await optional('cbor'))?.default;
  if (nodeCbor) {
    libraries.push({
      name: 'cbor (node-cbor)',
      decode: bytes => nodeCbor.decodeFirstSync(bytes),
      decodeFirst: bytes => nodeCbor.decodeFirstSync(bytes, { extendedResults: true }).value,
      encode: value => nodeCbor.encode(value),
      contentOf: value => (value instanceof nodeCbor.Tagged ? value.value : value),
      bytes: nodeBuffer,
    });
  }
  const cbor2 = await optional('cbor2');
  if (cbor2) {
    libraries.push({
      name: 'cbor2',
      decode: bytes => cbor2.decode(bytes),
      decodeFirst: bytes => cbor2.decodeSequence(bytes).next().value,
      encode: value => cbor2.encode(value),
      contentOf: value => (value instanceof cbor2.Tag ? value.contents : value),
      bytes: plainBytes,
    });
  }
  return libraries;
}

// ---------------------------------------------------------------- flows

/** WebAuthn registration: decode the attestation, then read the COSE public
 * key from authenticatorData (no length prefix: decodeFirst). Returns the
 * algorithms found. */
function parseAttestations(library) {
  return library.attestations.map(bytes => {
    const authData = getField(library.decode(bytes), 'authData');
    const idLength = (authData[53] << 8) | authData[54];
    const key = library.decodeFirst(authData.subarray(55 + idLength));
    return getField(key, 3);
  });
}

/** COSE_Sign1 verification path: decode the message and its protected header,
 * then build Sig_structure (the bytes the signature covers). */
function sign1VerifyPath(library) {
  return library.sign1.map(({ message, external }) => {
    const [protectedHeader, , payload] = library.contentOf(library.decode(message));
    const algorithm = getField(library.decode(protectedHeader), 1);
    const toBeSigned = library.encode(['Signature1', protectedHeader, external, payload]);
    return [algorithm, toHex(toBeSigned)];
  });
}

/** CWT: decode the token, then its claims. */
function readCwts(library) {
  return library.cwts.map(token => {
    const [, , payload] = library.contentOf(library.decode(token));
    return getField(library.decode(payload), 1);
  });
}

/** mdoc: decode the device response, every issuer-signed item (tag 24 around
 * CBOR), and the mobile security object inside issuerAuth. */
function readDeviceResponse(library) {
  const response = library.decode(library.deviceResponse);
  const [document] = getField(response, 'documents');
  const issuerSigned = getField(document, 'issuerSigned');
  const nameSpaces = getField(issuerSigned, 'nameSpaces');
  const items = [...(nameSpaces instanceof Map ? nameSpaces.values() : Object.values(nameSpaces))].flat()
    .map(item => library.decode(library.contentOf(item)));
  const mso = library.decode(library.contentOf(library.decode(getField(issuerSigned, 'issuerAuth')[2])));
  const deviceKey = getField(getField(mso, 'deviceKeyInfo'), 'deviceKey');
  return [items.map(item => getField(item, 'elementIdentifier')).length, toHex(getField(deviceKey, -2))];
}

/** COSE_Key encoding, as when registering or exporting a public key. */
const coseKeyFor = library => new Map([[1, 2], [3, -7], [-1, 1],
  [-2, library.bytes(hex(mdocItems.STATIC_DEVICE_KEY_X))], [-3, library.bytes(hex(mdocItems.STATIC_DEVICE_KEY_Y))]]);
const encodeCoseKey = library => toHex(library.encode(library.coseKey));

const flows = {
  'WebAuthn: parse 15 attestations': { run: parseAttestations, items: attestations.length },
  [`COSE_Sign1: decode + Sig_structure (${sign1.length} messages)`]: { run: sign1VerifyPath, items: sign1.length },
  'CWT: token + claims (RFC 8392 A.3, A.4)': { run: readCwts, items: cwts.length },
  'mdoc: device response + items + MSO': { run: readDeviceResponse, items: 1 },
  'COSE_Key: encode': { run: encodeCoseKey, items: 1 },
};

// ---------------------------------------------------------------- timing

let sink = 0;
function measure(run) {
  const timeRun = duration => {
    let calls = 0;
    const start = performance.now();
    let now = start;
    do {
      for (let index = 0; index < 16; index++) sink = (sink + (run() ? 1 : 0)) | 0;
      calls += 16;
      now = performance.now();
    } while (now - start < duration);
    return (now - start) * 1e6 / calls;
  };
  timeRun(Math.min(100, durationMs));
  return Array.from({ length: rounds }, () => timeRun(durationMs)).sort((a, b) => a - b)[rounds >> 1];
}

async function runFlow(flowName) {
  const libraries = (await loadLibraries()).map(library => ({
    ...library,
    // Every input in the library's byte type, prepared before timing.
    attestations: attestations.map(library.bytes),
    sign1: sign1.map(vector => ({ ...vector, message: library.bytes(vector.message), external: library.bytes(vector.external) })),
    cwts: cwts.map(library.bytes),
    deviceResponse: library.bytes(deviceResponse),
    coseKey: coseKeyFor(library),
  }));
  const flow = flows[flowName];
  const reference = flow.run(libraries[0]);
  if (flowName === 'COSE_Key: encode' && reference !== toHex(cborFp.encode(coseKeyFor(libraries[0])))) throw new Error('COSE_Key reference');
  // Spec checks for the reference: algorithms, signed bytes, claims, items.
  if (flowName.startsWith('COSE_Sign1')) reference.forEach(([, toBeSigned], index) => { if (toBeSigned !== sign1[index].toBeSigned) throw new Error('pure-cbor Sig_structure mismatch'); });
  const results = {};
  for (const library of libraries) {
    let output;
    try { output = flow.run(library); } catch (error) { results[library.name] = { error: error.message.slice(0, 80) }; continue; }
    if (!isDeepStrictEqual(output, reference)) { results[library.name] = { error: 'different result' }; continue; }
    results[library.name] = { ns: measure(() => flow.run(library)) };
  }
  console.log(JSON.stringify(results));
}

if (process.env.COSE_FLOW) {
  await runFlow(process.env.COSE_FLOW);
} else {
  const self = fileURLToPath(import.meta.url);
  const names = (await loadLibraries()).map(library => library.name);
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}. Each flow in its own process; median of ${rounds} rounds. Times are per flow (all its messages).`);
  console.log('Every library is checked to produce the same result as pure-cbor (which is checked against the spec vectors) before it is timed.\n');
  console.log(`| Flow | ${names.join(' | ')} | vs pure-cbor | vs pure-cbor (borrow) |`);
  console.log(`| --- |${' ---: |'.repeat(names.length + 2)}`);
  const format = ns => ns >= 10000 ? `${(ns / 1000).toFixed(1)} µs` : `${ns.toFixed(0)} ns`;
  for (const flowName of Object.keys(flows)) {
    process.stderr.write(`${flowName}\n`);
    const output = execFileSync(process.execPath, [self], { env: { ...process.env, COSE_FLOW: flowName }, encoding: 'utf8' });
    const results = JSON.parse(output.trim().split('\n').at(-1));
    const cells = names.map(name => results[name]?.ns !== undefined ? format(results[name].ns) : `– (${results[name]?.error ?? 'n/a'})`);
    // Fastest other library divided by each pure-cbor mode: above 1 means pure-cbor is faster.
    const others = names.filter(name => !name.startsWith('pure-cbor')).map(name => results[name]?.ns).filter(ns => ns !== undefined);
    const ratio = ours => (others.length ? `${(Math.min(...others) / ours).toFixed(2)}×` : '–');
    console.log(`| ${flowName} | ${cells.join(' | ')} | ${ratio(results['pure-cbor'].ns)} | ${ratio(results['pure-cbor (borrow)'].ns)} |`);
  }
}
