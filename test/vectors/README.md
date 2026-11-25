# Real-world CBOR test vectors

Public, openly licensed vectors from the specifications and projects where CBOR is used for security-sensitive data. `test/vectors.test.mjs` checks them and `bench/cose.mjs` benchmarks the flows. All files were retrieved on 2026-11-24.

| Folder | Source | License | Contents |
| --- | --- | --- | --- |
| `cose/` | [cose-wg/Examples](https://github.com/cose-wg/Examples): the COSE working group's examples for RFC 8152/9052, including the RFC 8392 CWT examples (`CWT/`) | The Unlicense (public domain); see `cose/LICENSE` | 63 JSON files: COSE_Sign1, COSE_Sign, COSE_Mac0 messages, ECDSA and EdDSA examples. Each has the encoded message (`output.cbor`) and the exact bytes that are signed or MACed (`intermediates.ToBeSign_hex` / `ToMac_hex`). Unmodified copies |
| `webauthn/webauthn-l3-test-vectors.json` | [W3C Web Authentication Level 3, §16 Test Vectors](https://www.w3.org/TR/webauthn-3/#sctn-test-vectors) | W3C Software and Document License | 15 registration vectors: none, packed, TPM, Android Key, Apple and FIDO U2F attestation; ES256/384/512, RS256, Ed25519 and Ed448 keys. Each has `attestationObject`, the expected AAGUID and credential ID, and an authentication assertion. Extracted from the spec's `name = h'...'` listings |
| `mdoc/iso-18013-5-annex-d.json` | ISO/IEC 18013-5:2021 (mobile driving licence) Annex D, as published in [openwallet-foundation/multipaz](https://github.com/openwallet-foundation/multipaz) `TestVectors.kt` | Apache-2.0 (Copyright 2022 The Android Open Source Project) | CBOR items from the Annex D presentation flow: device engagement, request, response, reader authentication, session messages, and the static device key coordinates. Certificates and the portrait image are omitted because they aren't CBOR |
