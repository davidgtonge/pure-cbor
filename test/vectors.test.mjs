// Real-world vectors (see test/vectors/README.md): COSE and CWT messages,
// WebAuthn attestations, and an ISO 18013-5 mobile driving licence flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { binary, decode, encode, read, isTagged, tagged } from '../dist/index.js';

const vectorPath = path => new URL(`./vectors/${path}`, import.meta.url);
const readJson = path => JSON.parse(readFileSync(vectorPath(path), 'utf8'));
const hex = text => Uint8Array.from(Buffer.from(text, 'hex'));
const toHex = bytes => Buffer.from(bytes).toString('hex');

// ---------------------------------------------------------------- COSE

const coseFolders = ['sign1-tests', 'sign-tests', 'ecdsa-examples', 'eddsa-examples', 'mac0-tests', 'CWT', 'RFC8152'];
const coseVectors = coseFolders.flatMap(folder => readdirSync(vectorPath(`cose/${folder}`))
  .filter(file => file.endsWith('.json'))
  .map(file => ({ file: `${folder}/${file}`, ...readJson(`cose/${folder}/${file}`) })));

// COSE message tags (RFC 9052 §2).
const COSE_TAGS = { 16: 'Encrypt0', 17: 'Mac0', 18: 'Sign1', 96: 'Encrypt', 97: 'Mac', 98: 'Sign' };

/** A COSE message is tag + 4-array, or the bare array (untagged forms). */
const unwrap = value => (isTagged(value) ? value.value : value);

test('COSE: all 63 example messages decode and re-encode to identical bytes', () => {
  assert.equal(coseVectors.length, 63);
  for (const vector of coseVectors) {
    const bytes = hex(vector.output.cbor);
    const message = decode(bytes);
    const body = unwrap(message);
    assert.ok(Array.isArray(body) && body.length >= 3, `${vector.file}: COSE structure`);
    assert.ok(body[0] instanceof Uint8Array, `${vector.file}: protected header is a byte string`);
    if (isTagged(message) && !vector.input.failures) assert.ok(message.tag in COSE_TAGS, `${vector.file}: COSE tag ${message.tag}`);
    // Preferred encodings and insertion-ordered Maps reproduce the exact bytes.
    assert.equal(toHex(encode(message)), vector.output.cbor.toLowerCase(), `${vector.file}: byte-exact round trip`);
  }
});

/** The external AAD a vector used (absent means empty). */
const externalAad = section => hex(section?.external ?? '');

test('COSE: rebuilt Sig_structure / MAC_structure match the signed bytes exactly', () => {
  let checked = 0;
  for (const vector of coseVectors) {
    // Failure vectors, and vectors with `failures`, were altered after signing
    // (e.g. sign-pass-01 carries h'a0' as its protected header but was signed
    // over h''; sign-fail-03 changed the algorithm): skip them.
    if (vector.input.failures !== undefined || vector.file.includes('fail')) continue;
    const body = unwrap(decode(hex(vector.output.cbor)));
    const [protectedHeader, , payload] = body;
    const { input, intermediates } = vector;
    if (input.sign0 && intermediates.ToBeSign_hex) {
      const toBeSigned = encode(['Signature1', protectedHeader, externalAad(input.sign0), payload]);
      assert.equal(toHex(toBeSigned), intermediates.ToBeSign_hex.toLowerCase(), `${vector.file}: Sig_structure`);
      checked++;
    }
    if (input.sign && intermediates.signers) {
      body[3].forEach((signature, index) => {
        const expected = intermediates.signers[index]?.ToBeSign_hex;
        if (!expected) return;
        const toBeSigned = encode(['Signature', protectedHeader, signature[0], externalAad(input.sign.signers?.[index] ?? input.sign), payload]);
        assert.equal(toHex(toBeSigned), expected.toLowerCase(), `${vector.file}: signer ${index} Sig_structure`);
        checked++;
      });
    }
    const mac = input.mac0 ?? input.mac;
    if (mac && intermediates.ToMac_hex) {
      const toMac = encode([input.mac0 ? 'MAC0' : 'MAC', protectedHeader, externalAad(mac), payload]);
      assert.equal(toHex(toMac), intermediates.ToMac_hex.toLowerCase(), `${vector.file}: MAC_structure`);
      checked++;
    }
  }
  assert.equal(checked, 31, 'Sig_structure and MAC_structure checks');
});

test('CWT: RFC 8392 claims decode from the signed and MACed tokens', () => {
  // RFC 8392 Appendix A.1, keyed by claim number.
  const expected = new Map([[1, 'coap://as.example.com'], [2, 'erikw'], [3, 'coap://light.example.com'],
    [4, 1444064944], [5, 1443944944], [6, 1443944944], [7, hex('0b71')]]);
  // A.3 (signed) and A.4 (MACed) carry the full claim set; A.7 is the
  // floating-point date example with only `iat`. A.5/A.6 are encrypted.
  const claimsOf = file => decode(unwrap(decode(hex(coseVectors.find(vector => vector.file === file).output.cbor)))[2]);
  assert.deepEqual(claimsOf('CWT/A_3.json'), expected); // integer keys decode as Map in 'auto' mode
  assert.deepEqual(claimsOf('CWT/A_4.json'), expected);
  assert.deepEqual(claimsOf('CWT/A_7.json'), new Map([[6, 1443944944.5]]));
});

// ---------------------------------------------------------------- WebAuthn

const webauthn = readJson('webauthn/webauthn-l3-test-vectors.json').vectors;

/** Parse authenticatorData (WebAuthn §6.1). The credential public key is a
 * COSE_Key written with no length prefix, so it is read with read(), which
 * returns where it ended; extensions, if flagged, follow it. */
function parseAuthenticatorData(authData) {
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const flags = authData[32];
  const result = { rpIdHash: authData.subarray(0, 32), flags, signCount: view.getUint32(33) };
  let offset = 37;
  if (flags & 0x40) { // attested credential data
    result.aaguid = authData.subarray(offset, offset + 16);
    const idLength = view.getUint16(offset + 16);
    result.credentialId = authData.subarray(offset + 18, offset + 18 + idLength);
    const [publicKey, next] = read(binary(authData), offset + 18 + idLength);
    result.publicKey = publicKey;
    offset = next;
  }
  if (flags & 0x80) { // extensions
    const [extensions, next] = read(binary(authData), offset);
    result.extensions = extensions;
    offset = next;
  }
  assert.equal(offset, authData.length, 'authenticatorData fully consumed');
  return result;
}

// COSE_Key expectations by algorithm (RFC 9053 / IANA COSE registries).
const keyShapes = {
  [-7]: { kty: 2, crv: 1, size: 32 },     // ES256, P-256
  [-35]: { kty: 2, crv: 2, size: 48 },    // ES384, P-384
  [-36]: { kty: 2, crv: 3, size: 66 },    // ES512, P-521
  [-8]: { kty: 1, size: undefined },      // EdDSA (Ed25519 or Ed448)
  [-19]: { kty: 1, size: undefined },     // Ed25519, fully specified (RFC 9864)
  [-53]: { kty: 1, size: undefined },     // Ed448, fully specified (RFC 9864)
  [-257]: { kty: 3 },                     // RS256
};

test('WebAuthn: all 15 Level 3 attestation vectors parse, with the right COSE keys', () => {
  assert.equal(webauthn.length, 15);
  for (const vector of webauthn) {
    const bytes = hex(vector.attestationObject);
    const attestation = decode(bytes);
    assert.deepEqual(Object.keys(attestation).sort(), ['attStmt', 'authData', 'fmt'], vector.section);
    assert.ok(['none', 'packed', 'tpm', 'android-key', 'apple', 'fido-u2f'].includes(attestation.fmt), `${vector.section}: fmt`);
    assert.equal(toHex(encode(attestation)), vector.attestationObject, `${vector.section}: byte-exact round trip`);

    const authData = parseAuthenticatorData(attestation.authData);
    assert.equal(toHex(authData.aaguid), vector.aaguid, `${vector.section}: AAGUID`);
    assert.equal(toHex(authData.credentialId), vector.credentialId, `${vector.section}: credential ID`);

    const key = authData.publicKey;
    assert.ok(key instanceof Map, `${vector.section}: COSE_Key is a Map (integer keys)`);
    const shape = keyShapes[key.get(3)];
    assert.ok(shape, `${vector.section}: known alg ${key.get(3)}`);
    assert.equal(key.get(1), shape.kty, `${vector.section}: kty`);
    if (shape.kty === 2) {
      assert.equal(key.get(-1), shape.crv);
      assert.equal(key.get(-2).length, shape.size);
      assert.equal(key.get(-3).length, shape.size);
    } else if (shape.kty === 1) {
      assert.ok([6, 7].includes(key.get(-1)), 'Ed25519 or Ed448');
      assert.equal(key.get(-2).length, key.get(-1) === 6 ? 32 : 57);
    } else {
      assert.ok(key.get(-1).length >= 256 && key.get(-2).length >= 3, 'RSA modulus and exponent');
    }
    if (attestation.fmt === 'packed') assert.equal(typeof attestation.attStmt.alg, 'number', `${vector.section}: attStmt.alg`);

    // The assertion's authenticatorData parses too (no attested credential).
    if (vector.assertion.authenticatorData) {
      const assertion = parseAuthenticatorData(hex(vector.assertion.authenticatorData));
      assert.equal(toHex(assertion.rpIdHash), toHex(authData.rpIdHash), `${vector.section}: same RP`);
    }
  }
});

test('WebAuthn: truncated and padded authenticator data are detected', () => {
  const attestation = decode(hex(webauthn[0].attestationObject));
  const authData = attestation.authData;
  // Cut inside the COSE key: read() reports truncation, not a wrong key.
  assert.throws(() => parseAuthenticatorData(authData.subarray(0, authData.length - 5)), e => e.code === 'truncated');
  // Extra bytes after the key are caught by the full-consumption check.
  const padded = new Uint8Array(authData.length + 1);
  padded.set(authData);
  assert.throws(() => parseAuthenticatorData(padded), assert.AssertionError);
});

// ---------------------------------------------------------------- mdoc

const mdoc = Object.fromEntries(Object.entries(readJson('mdoc/iso-18013-5-annex-d.json').items).map(([name, value]) => [name, hex(value)]));

/** Tag 24 wraps an encoded CBOR data item (RFC 8949 §3.4.5.1). */
const embedded = value => {
  assert.ok(isTagged(value) && value.tag === 24, 'tag 24');
  return decode(value.value);
};

test('mdoc: the ISO 18013-5 Annex D device response decodes, including embedded CBOR', () => {
  const response = decode(mdoc.DEVICE_RESPONSE);
  assert.equal(response.version, '1.0');
  assert.equal(response.status, 0);
  const [document] = response.documents;
  assert.equal(document.docType, 'org.iso.18013.5.1.mDL');
  // Issuer-signed elements: each is tag 24 around an IssuerSignedItem.
  const elements = Object.values(document.issuerSigned.nameSpaces).flat().map(embedded);
  const names = elements.map(item => item.elementIdentifier);
  assert.ok(names.includes('family_name') && names.includes('document_number'), names.join(', '));
  for (const item of elements) assert.ok(item.random instanceof Uint8Array && typeof item.digestID === 'number');
  const birthDate = elements.find(item => item.elementIdentifier === 'issue_date')?.elementValue;
  assert.ok(isTagged(birthDate) && birthDate.tag === 1004, 'full-date (tag 1004) passes through as Tagged');
  // issuerAuth is COSE_Sign1; its payload is tag 24 around the Mobile Security Object.
  const [protectedHeader, unprotectedHeader, payload] = document.issuerSigned.issuerAuth;
  assert.equal(decode(protectedHeader).get(1), -7, 'ES256');
  assert.ok(unprotectedHeader.get(33) instanceof Uint8Array, 'x5chain');
  const mso = embedded(decode(payload));
  assert.equal(mso.docType, 'org.iso.18013.5.1.mDL');
  assert.ok(mso.validityInfo.signed instanceof Date, 'tdate (tag 0) becomes Date');
  const deviceKey = mso.deviceKeyInfo.deviceKey;
  assert.equal(toHex(deviceKey.get(-2)), toHex(mdoc.STATIC_DEVICE_KEY_X));
  assert.equal(toHex(deviceKey.get(-3)), toHex(mdoc.STATIC_DEVICE_KEY_Y));
});

test('mdoc: every Annex D message decodes; keeping tags as written gives byte-exact round trips', () => {
  // Dates decode to Date by default, which would re-encode as tag 1. To keep
  // the issuer's exact bytes, decode tag 0 as Tagged instead.
  const keepAsWritten = { tags: { 0: content => tagged(0, content) } };
  for (const name of ['DEVICE_ENGAGEMENT', 'E_DEVICE_KEY_BYTES', 'DEVICE_RESPONSE', 'SESSION_TRANSCRIPT_BYTES', 'DEVICE_REQUEST',
    'ITEMS_REQUEST', 'READER_AUTH', 'SESSION_ESTABLISHMENT', 'SESSION_DATA', 'SESSION_TERMINATION']) {
    const value = decode(mdoc[name], keepAsWritten);
    assert.equal(toHex(encode(value)), toHex(mdoc[name]), `${name}: byte-exact round trip`);
  }
  const deviceKey = embedded(decode(mdoc.E_DEVICE_KEY_BYTES));
  assert.equal(deviceKey.get(1), 2, 'EC2 ephemeral device key');
  const [engagementBytes, readerKeyBytes, handover] = embedded(decode(mdoc.SESSION_TRANSCRIPT_BYTES));
  // The transcript's engagement omits the retrieval methods the standalone
  // engagement carries, but both hold the same security entry (device key).
  const engagement = embedded(engagementBytes);
  assert.equal(engagement.get(0), '1.0');
  assert.deepEqual(engagement.get(1), decode(mdoc.DEVICE_ENGAGEMENT).get(1));
  assert.equal(embedded(readerKeyBytes).get(1), 2);
  // Annex D uses NFC handover: [HandoverSelect message, HandoverRequest message].
  assert.ok(Array.isArray(handover) && handover.length === 2 && handover.every(part => part instanceof Uint8Array));
});
