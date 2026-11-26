import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, tagged, isTagged, CborError, STRICT_DECODE } from '../dist/index.js';

// Strict decoding for security formats, as pure-cose needs it.

const hex = string => Uint8Array.from(Buffer.from(string.replace(/\s/g, ''), 'hex'));
const error = (code, offset) => exception =>
  exception instanceof CborError && exception.code === code && (offset === undefined || exception.offset === offset);

test("mapKeys: 'integer-or-text' rejects every other key, at the key's offset", () => {
  // {1.0: -7}: decodes as {1: -7} unless keys are checked.
  assert.deepEqual(decode(hex('a1 f93c00 26'), { maps: 'map' }), new Map([[1, -7]]));
  for (const maps of ['auto', 'map']) {
    assert.throws(() => decode(hex('a1 f93c00 26'), { maps, mapKeys: 'integer-or-text' }), error('unsupported-type', 1), maps);
  }
  const options = { maps: 'map', mapKeys: 'integer-or-text' };
  for (const [wire, what] of [
    ['a1 fb3ff0000000000000 01', 'float64'], ['a1 4101 01', 'byte string'], ['a1 8101 01', 'array'],
    ['a1 a10102 01', 'map'], ['a1 c101 01', 'tag'], ['a1 f4 01', 'false'], ['a1 f6 01', 'null'],
  ]) {
    assert.throws(() => decode(hex(wire), options), error('unsupported-type', 1), what);
  }
  // Integers of every width, negative integers and text (also in chunks) are allowed.
  assert.deepEqual(decode(hex('a5 01 01 20 02 1b0000000100000000 03 6161 04 7f6162ff 05'), options),
    new Map([[1, 1], [-1, 2], [4294967296, 3], ['a', 4], ['b', 5]]));
  // 'auto' moves to a Map at the first non-text key; that key is checked too.
  assert.throws(() => decode(hex('a2 6161 01 f93c00 02'), { mapKeys: 'integer-or-text' }), error('unsupported-type', 4));
  // Values are not restricted, and nested maps are checked as well.
  assert.deepEqual(decode(hex('a1 01 f93e00'), options), new Map([[1, 1.5]]));
  assert.throws(() => decode(hex('a1 01 a1 4101 01'), options), error('unsupported-type', 3));
});

test("tags: 'reject' fails at the tag's header, before its content", () => {
  assert.throws(() => decode(hex('d9d9f7 01'), { tags: { 55799: 'reject' } }), error('unsupported-tag', 0));
  assert.throws(() => decode(hex('82 01 d9d9f7 01'), { tags: { 55799: 'reject' } }), error('unsupported-tag', 2));
  assert.throws(() => decode(hex('c1 1a514b67b0'), { tags: { 1: 'reject' } }), error('unsupported-tag', 0));
  // Content that would itself be malformed is never read.
  assert.throws(() => decode(hex('d82a ff'), { tags: { 42: 'reject' } }), error('unsupported-tag', 0));
});

test("unknownTags: 'reject' also rejects tag 55799; by default it is unwrapped", () => {
  assert.equal(decode(hex('d9d9f7 01')), 1);
  assert.throws(() => decode(hex('d9d9f7 01'), { unknownTags: 'reject' }), error('unsupported-tag', 0));
  // An explicit entry wins over unknownTags.
  assert.equal(decode(hex('d9d9f7 01'), { unknownTags: 'reject', tags: { 55799: content => content } }), 1);
});

test("tags: 'tagged' keeps a tag, skipping typed-array and other built-in conversions", () => {
  const kept = (wire, tag) => {
    const value = decode(hex(wire), { tags: { [tag]: 'tagged' } });
    assert.ok(isTagged(value), wire);
    assert.equal(value.tag, tag);
    return value.value;
  };
  assert.deepEqual(kept('d840 420102', 64), Uint8Array.of(1, 2));          // uint8 typed array
  assert.deepEqual(kept('d852 483ff8000000000000', 82), hex('3ff8000000000000')); // float64 BE
  assert.equal(kept('c1 1a514b67b0', 1), 1363896240);                    // not a Date
  assert.deepEqual(kept('c2 4101', 2), Uint8Array.of(1));                // not a bigint
  assert.equal(kept('d9d9f7 01', 55799), 1);
  // Without an entry the built-ins still apply, and decoders still work.
  assert.deepEqual(decode(hex('d840 420102')), Uint8Array.of(1, 2));
  assert.equal(decode(hex('d82a 01'), { tags: { 42: content => content + 1 } }), 2);
});

test('STRICT_DECODE: the profile COSE needs, frozen', () => {
  assert.ok(Object.isFrozen(STRICT_DECODE) && Object.isFrozen(STRICT_DECODE.tags));
  assert.throws(() => { STRICT_DECODE.maps = 'auto'; }, TypeError);
  // Every map is a Map, including empty and text-keyed ones.
  assert.deepEqual(decode(hex('a0'), STRICT_DECODE), new Map());
  assert.deepEqual(decode(hex('a1 6161 01'), STRICT_DECODE), new Map([['a', 1]]));
  // A COSE_Key round trips.
  const coseKey = new Map([[1, 2], [3, -7], [-1, 1], [-2, Uint8Array.of(1, 2, 3)], ['kid', 'key-1']]);
  assert.deepEqual(decode(encode(coseKey), STRICT_DECODE), coseKey);
  // Each rule applies.
  assert.throws(() => decode(hex('a1 f93c00 26'), STRICT_DECODE), error('unsupported-type', 1)); // float key
  assert.throws(() => decode(hex('d9d9f7 a0'), STRICT_DECODE), error('unsupported-tag', 0));     // self-described
  assert.throws(() => decode(hex('d82a 01'), STRICT_DECODE), error('unsupported-tag', 0));       // unknown tag
  assert.throws(() => decode(hex('a2 01 01 01 02'), STRICT_DECODE), error('duplicate-key'));
  assert.throws(() => decode(hex('62 c328'), STRICT_DECODE), error('invalid-utf8'));
  const typedArray = decode(hex('d840 420102'), STRICT_DECODE);                                   // stays a tag
  assert.ok(isTagged(typedArray) && typedArray.tag === 64);
  for (let tag = 64; tag <= 87; tag++) assert.equal(STRICT_DECODE.tags[tag], 'tagged');
  // Dates and bignums keep their built-in meaning.
  assert.ok(decode(hex('c1 1a514b67b0'), STRICT_DECODE) instanceof Date);
  // Spread it to change one field.
  assert.ok(isTagged(decode(hex('d82a 01'), { ...STRICT_DECODE, unknownTags: 'tagged' })));
  assert.deepEqual(decode(encode(tagged(42, 1)), { ...STRICT_DECODE, unknownTags: 'tagged' }), tagged(42, 1));
});
