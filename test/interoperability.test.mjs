import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../dist/index.js';

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = 'true';
let reference;
try { reference = await import('cbor-x'); }
catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }

test('bidirectional cbor-x interoperability (optional reference package)', { skip: !reference }, () => {
  const encoder = new reference.Encoder({ useRecords: false });
  const decoder = new reference.Decoder({ copyBuffers: true });
  const values = [0, 24, -25, 2 ** 32 - 1, -(2 ** 32), Math.PI, Infinity, NaN,
    null, true, false, [null, true, false, 1, 'x'], '', 'hello', 'é水😀', 'long unicode é😀'.repeat(100), [], [1, 2, 3], ['hello', 'é', 42, Math.PI],
    new Uint8Array([0, 1, 255]), new Uint8ClampedArray([0, 255]),
    new Int8Array([-1, 127]), new Uint16Array([1, 65535]), new Int16Array([-1, 32767]),
    new Uint32Array([1, 0xffffffff]), new Int32Array([-1, 2147483647]),
    new Float32Array([Math.PI, -0, Infinity]), new Float64Array([Math.PI, -0, Infinity]),
    new BigUint64Array([0n, (1n << 64n) - 1n]), new BigInt64Array([-1n, 0n])];
  const same = (a, b) => {
    if (ArrayBuffer.isView(b)) {
      assert.equal(Object.prototype.toString.call(a), Object.prototype.toString.call(b));
      assert.deepEqual([...a], [...b]);
    } else if (Array.isArray(b)) assert.deepEqual(a, b);
    else assert.ok(Object.is(a, b));
  };
  for (const v of values) {
    same(decode(encoder.encode(v)), v);
    same(decoder.decode(encode(v)), v);
  }
});
