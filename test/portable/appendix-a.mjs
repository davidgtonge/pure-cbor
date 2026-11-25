// RFC 8949 Appendix A, shared by the Node tests and the portable suite.
import { simple, tagged } from '../../dist/index.js';

const bytesOf = (...values) => new Uint8Array(values);

// RFC 8949 Appendix A. [wire, decoded value, encodes back to the same wire?]
// Integral floats (1.0, 65504.0, ...) are integers in JS, so they decode to the
// same number but encode as integers; NaN payloads aside, every vector decodes.
export const appendixA = [
  ['00', 0, true], ['01', 1, true], ['0a', 10, true], ['17', 23, true], ['1818', 24, true], ['1819', 25, true],
  ['1864', 100, true], ['1903e8', 1000, true], ['1a000f4240', 1000000, true], ['1b000000e8d4a51000', 1000000000000, true],
  ['1bffffffffffffffff', 18446744073709551615n, true], ['c249010000000000000000', 18446744073709551616n, true],
  ['3bffffffffffffffff', -18446744073709551616n, true], ['c349010000000000000000', -18446744073709551617n, true],
  ['20', -1, true], ['29', -10, true], ['3863', -100, true], ['3903e7', -1000, true],
  ['f90000', 0, false], ['f98000', -0, 'shortest'], ['f93c00', 1, false], ['fb3ff199999999999a', 1.1, true],
  ['f93e00', 1.5, 'shortest'], ['f97bff', 65504, false], ['fa47c35000', 100000, false],
  ['fa7f7fffff', 3.4028234663852886e+38, 'shortest'], ['fb7e37e43c8800759c', 1.0e+300, true],
  ['f90001', 5.960464477539063e-8, 'shortest'], ['f90400', 0.00006103515625, 'shortest'], ['f9c400', -4, false],
  ['fbc010666666666666', -4.1, true], ['f97c00', Infinity, 'shortest'], ['f97e00', NaN, 'shortest'], ['f9fc00', -Infinity, 'shortest'],
  ['fa7f800000', Infinity, false], ['fa7fc00000', NaN, false], ['faff800000', -Infinity, false],
  ['fb7ff0000000000000', Infinity, true], ['fb7ff8000000000000', NaN, true], ['fbfff0000000000000', -Infinity, true],
  ['f4', false, true], ['f5', true, true], ['f6', null, true], ['f7', undefined, true],
  ['f0', simple(16), true], ['f8ff', simple(255), true],
  ['c074323031332d30332d32315432303a30343a30305a', new Date('2013-03-21T20:04:00Z'), false],
  ['c11a514b67b0', new Date(1363896240000), true], ['c1fb41d452d9ec200000', new Date(1363896240500), true],
  ['d74401020304', tagged(23, bytesOf(1, 2, 3, 4)), true], ['d818456449455446', tagged(24, bytesOf(0x64, 0x49, 0x45, 0x54, 0x46)), true],
  ['d82076687474703a2f2f7777772e6578616d706c652e636f6d', tagged(32, 'http://www.example.com'), true],
  ['40', new Uint8Array(0), true], ['4401020304', bytesOf(1, 2, 3, 4), true],
  ['60', '', true], ['6161', 'a', true], ['6449455446', 'IETF', true], ['62225c', '"\\', true], ['62c3bc', 'ü', true],
  ['63e6b0b4', '水', true], ['64f0908591', '𐅑', true],
  ['80', [], true], ['83010203', [1, 2, 3], true], ['8301820203820405', [1, [2, 3], [4, 5]], true],
  ['98190102030405060708090a0b0c0d0e0f101112131415161718181819', Array.from({ length: 25 }, (_, i) => i + 1), true],
  ['a0', {}, true], ['a201020304', new Map([[1, 2], [3, 4]]), true], ['a26161016162820203', { a: 1, b: [2, 3] }, true],
  ['826161a161626163', ['a', { b: 'c' }], true],
  ['a56161614161626142616361436164614461656145', { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }, true],
  ['5f42010243030405ff', bytesOf(1, 2, 3, 4, 5), false], ['7f657374726561646d696e67ff', 'streaming', false],
  ['9fff', [], false], ['9f018202039f0405ffff', [1, [2, 3], [4, 5]], false], ['9f01820203820405ff', [1, [2, 3], [4, 5]], false],
  ['83018202039f0405ff', [1, [2, 3], [4, 5]], false], ['83019f0203ff820405', [1, [2, 3], [4, 5]], false],
  ['9f0102030405060708090a0b0c0d0e0f101112131415161718181819ff', Array.from({ length: 25 }, (_, i) => i + 1), false],
  ['bf61610161629f0203ffff', { a: 1, b: [2, 3] }, false], ['826161bf61626163ff', ['a', { b: 'c' }], false],
  ['bf6346756ef563416d7421ff', { Fun: true, Amt: -2 }, false],
];
