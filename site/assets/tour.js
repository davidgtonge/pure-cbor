// pure-cbor documentation: the playground and the streaming demo. Both run
// the real library, built from src/ and served from ../lib/ (the Pages
// workflow copies dist/ there). Nothing here evaluates user input: values
// are read by a small literal parser, and bytes by an annotator that only
// describes them.

const LIBRARY_URL = new URL('../lib/index.js', import.meta.url).href;

// ================================================================ value literals

const TYPED_ARRAY_CONSTRUCTORS = {
  Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

class LiteralError extends Error {
  constructor(message, position) {
    super(`${message} (at character ${position + 1})`);
    this.position = position;
  }
}

const NUMBER_PATTERN = /-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)n?/y;
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/y;

// Reads a JavaScript literal: objects, arrays, strings, numbers, bigints,
// true/false/null/undefined/NaN/Infinity, new Map/Date/typed arrays, and
// tagged()/simple() from the library.
function parseLiteral(source, library) {
  let position = 0;

  const fail = (message) => { throw new LiteralError(message, position); };

  const skipSpace = () => {
    for (;;) {
      while (position < source.length && /\s/.test(source[position])) position++;
      if (source.startsWith('//', position)) {
        while (position < source.length && source[position] !== '\n') position++;
      } else if (source.startsWith('/*', position)) {
        const end = source.indexOf('*/', position + 2);
        if (end < 0) fail('Unclosed comment');
        position = end + 2;
      } else {
        return;
      }
    }
  };

  const peek = () => { skipSpace(); return source[position]; };

  const expect = (character) => {
    if (peek() !== character) fail(`Expected "${character}"`);
    position++;
  };

  const readIdentifier = () => {
    skipSpace();
    IDENTIFIER_PATTERN.lastIndex = position;
    const match = IDENTIFIER_PATTERN.exec(source);
    if (!match) fail('Expected a name');
    position += match[0].length;
    return match[0];
  };

  const readString = () => {
    const quote = source[position];
    let text = '';
    position++;
    while (position < source.length && source[position] !== quote) {
      const character = source[position];
      if (character === '\n') fail('Unterminated string');
      if (character !== '\\') { text += character; position++; continue; }
      const escape = source[position + 1];
      position += 2;
      const simpleEscapes = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
      if (escape in simpleEscapes) text += simpleEscapes[escape];
      else if (escape === 'u' && source[position] === '{') {
        const end = source.indexOf('}', position);
        if (end < 0) fail('Bad \\u{…} escape');
        text += String.fromCodePoint(parseInt(source.slice(position + 1, end), 16));
        position = end + 1;
      } else if (escape === 'u' || escape === 'x') {
        const digitCount = escape === 'u' ? 4 : 2;
        const digits = source.slice(position, position + digitCount);
        if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== digitCount) fail(`Bad \\${escape} escape`);
        text += String.fromCharCode(parseInt(digits, 16));
        position += digitCount;
      } else if (escape === undefined) fail('Unterminated string');
      else text += escape;
    }
    if (position >= source.length) fail('Unterminated string');
    position++;
    return text;
  };

  const readNumber = () => {
    NUMBER_PATTERN.lastIndex = position;
    const match = NUMBER_PATTERN.exec(source);
    if (!match) fail('Expected a number');
    position += match[0].length;
    const text = match[0];
    if (text.endsWith('n')) {
      const digits = text.slice(0, -1);
      if (/[.eE]/.test(digits) && !/^-?0[xX]/.test(digits)) fail('A bigint must be an integer');
      return digits.startsWith('-') ? -BigInt(digits.slice(1)) : BigInt(digits);
    }
    return text.startsWith('-') ? -Number(text.slice(1)) : Number(text);
  };

  const readList = (closing, readItem) => {
    const items = [];
    while (peek() !== closing) {
      if (position >= source.length) fail(`Expected "${closing}"`);
      items.push(readItem());
      if (peek() === ',') position++;
      else if (peek() !== closing) fail(`Expected "," or "${closing}"`);
    }
    position++;
    return items;
  };

  const readArguments = () => { expect('('); return readList(')', readValue); };

  const readObject = () => {
    position++;
    const object = {};
    readList('}', () => {
      const start = peek();
      let key;
      if (start === '"' || start === "'") key = readString();
      else if (start === '[') fail('Computed keys are not supported');
      else if (/[\d.-]/.test(start)) key = String(readNumber());
      else key = readIdentifier();
      expect(':');
      Object.defineProperty(object, key, { value: readValue(), enumerable: true, writable: true, configurable: true });
      return key;
    });
    return object;
  };

  const readConstructed = () => {
    const name = readIdentifier();
    const constructorStart = position;
    const args = readArguments();
    if (name === 'Map') {
      if (args.length === 0) return new Map();
      if (!Array.isArray(args[0]) || !args[0].every((entry) => Array.isArray(entry) && entry.length === 2)) {
        position = constructorStart;
        fail('new Map() takes an array of [key, value] pairs');
      }
      return new Map(args[0]);
    }
    if (name === 'Date') {
      if (args.length !== 1) fail('new Date() takes one argument here');
      return new Date(args[0]);
    }
    const TypedArray = TYPED_ARRAY_CONSTRUCTORS[name];
    if (TypedArray) {
      if (args.length !== 1) fail(`new ${name}() takes one argument`);
      const isBigIntArray = name.startsWith('Big');
      const content = Array.isArray(args[0]) && isBigIntArray ? args[0].map((item) => BigInt(item)) : args[0];
      return new TypedArray(content);
    }
    position = constructorStart;
    return fail(`Unsupported constructor ${name}`);
  };

  function readValue() {
    const character = peek();
    if (character === undefined) fail('Expected a value');
    if (character === '{') return readObject();
    if (character === '[') { position++; return readList(']', readValue); }
    if (character === '"' || character === "'") return readString();
    if (character === '-' && source.startsWith('-Infinity', position)) { position += 9; return -Infinity; }
    if (/[\d.-]/.test(character)) return readNumber();
    const start = position;
    const name = readIdentifier();
    switch (name) {
      case 'true': return true;
      case 'false': return false;
      case 'null': return null;
      case 'undefined': return undefined;
      case 'NaN': return NaN;
      case 'Infinity': return Infinity;
      case 'new': return readConstructed();
      case 'tagged': {
        const args = readArguments();
        if (args.length !== 2) fail('tagged(tag, value) takes two arguments');
        return library.tagged(Number(args[0]), args[1]);
      }
      case 'simple': {
        const args = readArguments();
        if (args.length !== 1) fail('simple(n) takes one argument');
        return library.simple(args[0]);
      }
      default:
        position = start;
        return fail(`Unknown name "${name}"`);
    }
  }

  const value = readValue();
  if (peek() !== undefined) fail('Unexpected text after the value');
  return value;
}

// ================================================================ printing values

const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/;
const MAX_LISTED = 40;

function quote(text) {
  return "'" + text.replace(/[\\'\n\r\t\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) => {
    const named = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' }[character];
    return named || '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
  }) + "'";
}

function formatNumber(number) {
  return Object.is(number, -0) ? '-0' : String(number);
}

function listParts(items, formatItem) {
  const parts = items.slice(0, MAX_LISTED).map(formatItem);
  if (items.length > MAX_LISTED) parts.push(`/* … ${items.length - MAX_LISTED} more */`);
  return parts;
}

function joinParts(open, parts, close, indent) {
  if (parts.length === 0) return open + close;
  const oneLine = `${open}${parts.join(', ')}${close}`;
  if (oneLine.length <= 72 && !oneLine.includes('\n')) return oneLine;
  const inner = indent + '  ';
  return `${open}\n${parts.map((part) => inner + part).join(',\n')}\n${indent}${close}`;
}

function formatValue(value, library, indent = '') {
  const next = indent + '  ';
  switch (typeof value) {
    case 'undefined': return 'undefined';
    case 'boolean': return String(value);
    case 'number': return formatNumber(value);
    case 'bigint': return `${value}n`;
    case 'string': return quote(value);
  }
  if (value === null) return 'null';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'new Date(NaN)' : `new Date('${value.toISOString()}')`;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const name = value.constructor.name;
    const items = Array.from(value, (item) => (typeof item === 'bigint' ? `${item}n` : name.startsWith('Uint8') ? '0x' + item.toString(16).padStart(2, '0') : formatNumber(item)));
    return `new ${name}(${joinParts('[', listParts(items, (item) => item), ']', indent)})`;
  }
  if (Array.isArray(value)) {
    const items = Array.from(value);
    return joinParts('[', listParts(items, (item) => formatValue(item, library, next)), ']', indent);
  }
  if (value instanceof Map) {
    const entries = Array.from(value);
    const parts = listParts(entries, ([key, item]) => `[${formatValue(key, library, next)}, ${formatValue(item, library, next)}]`);
    return `new Map(${joinParts('[', parts, ']', indent)})`;
  }
  if (library.isTagged(value)) return `tagged(${value.tag}, ${formatValue(value.value, library, indent)})`;
  if (library.isSimpleValue(value)) return `simple(${value.simple})`;
  const keys = Object.keys(value);
  const parts = listParts(keys, (key) => `${IDENTIFIER_KEY.test(key) ? key : quote(key)}: ${formatValue(value[key], library, next)}`);
  return joinParts('{ ', parts, ' }', indent).replace(/^\{ \n/, '{\n').replace(/\n(\s*) \}$/, '\n$1}');
}

// Bytes a value would take as JSON, when it is plain JSON data.
function jsonByteLength(value) {
  const isJson = (item) => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return true;
    if (typeof item === 'number') return Number.isFinite(item) && !Object.is(item, -0);
    if (Array.isArray(item)) return item.every(isJson);
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) return Object.values(item).every(isJson);
    return false;
  };
  return isJson(value) ? new TextEncoder().encode(JSON.stringify(value)).length : null;
}

// ================================================================ annotating bytes

const TAG_NAMES = {
  0: 'date/time text', 1: 'epoch date', 2: 'positive bignum', 3: 'negative bignum', 4: 'decimal fraction',
  5: 'bigfloat', 21: 'base64url hint', 22: 'base64 hint', 23: 'base16 hint', 24: 'embedded CBOR', 32: 'URI',
  33: 'base64url text', 34: 'base64 text', 36: 'MIME message', 55799: 'self-described CBOR',
  64: 'uint8 array', 65: 'uint16 BE array', 66: 'uint32 BE array', 67: 'uint64 BE array', 68: 'uint8 clamped array',
  69: 'uint16 LE array', 70: 'uint32 LE array', 71: 'uint64 LE array', 72: 'sint8 array', 73: 'sint16 BE array',
  74: 'sint32 BE array', 75: 'sint64 BE array', 77: 'sint16 LE array', 78: 'sint32 LE array', 79: 'sint64 LE array',
  80: 'float16 BE array', 81: 'float32 BE array', 82: 'float64 BE array', 83: 'float128 BE array',
  84: 'float16 LE array', 85: 'float32 LE array', 86: 'float64 LE array', 87: 'float128 LE array',
};
const MAX_ANNOTATED_ITEMS = 1500;
const MAX_ANNOTATED_DEPTH = 200;
const strictText = new TextDecoder('utf-8', { fatal: true });

class AnnotationStop extends Error {
  constructor(message, offset) { super(message); this.offset = offset; }
}

function hex(bytes, start, end) {
  let text = '';
  for (let index = start; index < end; index++) text += bytes[index].toString(16).padStart(2, '0');
  return text;
}

function float16(bits) {
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

// Describes every item in `bytes`, top level first. Returns the items (with
// byte ranges, depth and a description), the owner item of each byte, and
// where annotation stopped if the bytes are malformed.
function annotate(bytes) {
  const items = [];
  const owner = new Int32Array(bytes.length).fill(-1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const need = (offset, count) => {
    if (offset + count > bytes.length) throw new AnnotationStop(`Needs ${offset + count - bytes.length} more byte${offset + count - bytes.length === 1 ? '' : 's'}`, offset);
  };

  const readArgument = (offset) => {
    need(offset, 1);
    const additionalInfo = bytes[offset] & 31;
    if (additionalInfo < 24) return { value: additionalInfo, headerLength: 1 };
    if (additionalInfo === 31) return { value: null, headerLength: 1 };
    if (additionalInfo > 27) throw new AnnotationStop(`Reserved additional information ${additionalInfo}`, offset);
    const width = 2 ** (additionalInfo - 24);
    need(offset + 1, width);
    let value;
    if (width === 1) value = bytes[offset + 1];
    else if (width === 2) value = view.getUint16(offset + 1);
    else if (width === 4) value = view.getUint32(offset + 1);
    else {
      value = view.getBigUint64(offset + 1);
      if (value <= BigInt(Number.MAX_SAFE_INTEGER)) value = Number(value);
    }
    return { value, headerLength: 1 + width };
  };

  const addItem = (item) => {
    if (items.length >= MAX_ANNOTATED_ITEMS) throw new AnnotationStop(`Annotation stops after ${MAX_ANNOTATED_ITEMS} items`, item.start);
    items.push(item);
    return items.length - 1;
  };

  const own = (itemIndex, start, end) => { for (let index = start; index < end; index++) owner[index] = itemIndex; };

  const walk = (offset, depth, role) => {
    if (depth > MAX_ANNOTATED_DEPTH) throw new AnnotationStop('Nested too deeply to annotate', offset);
    need(offset, 1);
    const token = bytes[offset];
    const major = token >> 5;
    const additionalInfo = token & 31;
    const { value: argument, headerLength } = readArgument(offset);
    const headerEnd = offset + headerLength;
    const indefinite = additionalInfo === 31;
    const item = { start: offset, headerEnd, end: headerEnd, depth, role, major, kind: '', text: '' };
    const itemIndex = addItem(item);
    own(itemIndex, offset, headerEnd);

    const walkUntilBreak = (childRole) => {
      let position = headerEnd;
      let count = 0;
      for (;;) {
        need(position, 1);
        if (bytes[position] === 0xff) {
          const breakIndex = addItem({ start: position, headerEnd: position + 1, end: position + 1, depth: depth + 1, role: '', major: 7, kind: 'break', text: 'end of the indefinite item' });
          own(breakIndex, position, position + 1);
          return { end: position + 1, count };
        }
        position = walk(position, depth + 1, childRole(count));
        count++;
      }
    };

    switch (major) {
      case 0:
      case 1: {
        if (indefinite) throw new AnnotationStop('Integers cannot be indefinite', offset);
        item.kind = major === 0 ? 'unsigned integer' : 'negative integer';
        item.text = major === 0 ? String(argument) : typeof argument === 'bigint' ? String(-1n - argument) : String(-1 - argument);
        break;
      }
      case 2:
      case 3: {
        const noun = major === 2 ? 'byte string' : 'text';
        if (indefinite) {
          const { end, count } = walkUntilBreak(() => 'chunk');
          item.kind = `${noun}, in chunks`;
          item.text = `${count} chunk${count === 1 ? '' : 's'}`;
          item.end = end;
          break;
        }
        if (typeof argument === 'bigint' || argument > bytes.length) throw new AnnotationStop(`Declares ${argument} bytes; only ${bytes.length - headerEnd} remain`, offset);
        need(headerEnd, argument);
        item.end = headerEnd + argument;
        own(itemIndex, headerEnd, item.end);
        if (major === 2) {
          item.kind = `byte string, ${argument} byte${argument === 1 ? '' : 's'}`;
          item.text = argument === 0 ? "h''" : `h'${hex(bytes, headerEnd, Math.min(item.end, headerEnd + 24))}${argument > 24 ? '…' : ''}'`;
        } else {
          item.kind = `text, ${argument} byte${argument === 1 ? '' : 's'}`;
          try {
            const text = strictText.decode(bytes.subarray(headerEnd, item.end));
            item.text = JSON.stringify(text.length > 60 ? text.slice(0, 60) + '…' : text);
          } catch {
            item.text = 'invalid UTF-8';
            item.invalid = true;
          }
        }
        break;
      }
      case 4:
      case 5: {
        const isMap = major === 5;
        const childRole = (index) => (isMap ? (index % 2 === 0 ? 'key' : 'value') : `[${index}]`);
        if (indefinite) {
          const { end, count } = walkUntilBreak(childRole);
          item.end = end;
          item.kind = isMap ? 'map, indefinite length' : 'array, indefinite length';
          item.text = isMap ? `${count / 2} entr${count === 2 ? 'y' : 'ies'}` : `${count} item${count === 1 ? '' : 's'}`;
          break;
        }
        const childCount = isMap ? 2 * Number(argument) : Number(argument);
        if (typeof argument === 'bigint' || childCount > bytes.length - headerEnd) throw new AnnotationStop(`Declares ${argument} ${isMap ? 'entries' : 'items'}; the input is too short for them`, offset);
        item.kind = isMap ? 'map' : 'array';
        item.text = isMap ? `${argument} entr${argument === 1 ? 'y' : 'ies'}` : `${argument} item${argument === 1 ? '' : 's'}`;
        let position = headerEnd;
        for (let index = 0; index < childCount; index++) position = walk(position, depth + 1, childRole(index));
        item.end = position;
        break;
      }
      case 6: {
        if (indefinite) throw new AnnotationStop('Tags cannot be indefinite', offset);
        item.kind = 'tag';
        item.text = `${argument}${TAG_NAMES[argument] ? ` (${TAG_NAMES[argument]})` : ''}`;
        item.end = walk(headerEnd, depth + 1, 'content');
        break;
      }
      default: {
        if (additionalInfo === 31) throw new AnnotationStop('Unexpected break (ff)', offset);
        if (additionalInfo < 24 || additionalInfo === 24) {
          const names = { 20: 'false', 21: 'true', 22: 'null', 23: 'undefined' };
          item.kind = 'simple value';
          item.text = names[argument] || `simple(${argument})`;
          if (additionalInfo === 24 && argument < 32) throw new AnnotationStop('A two-byte simple value must be 32 or more', offset);
        } else {
          const widthName = { 25: 'half', 26: 'single', 27: 'double' }[additionalInfo];
          const floatValue = additionalInfo === 25 ? float16(view.getUint16(offset + 1))
            : additionalInfo === 26 ? view.getFloat32(offset + 1) : view.getFloat64(offset + 1);
          item.kind = `float, ${widthName} precision`;
          item.text = formatNumber(floatValue);
        }
      }
    }
    return item.end;
  };

  let stop = null;
  let offset = 0;
  let topLevelCount = 0;
  try {
    while (offset < bytes.length) {
      offset = walk(offset, 0, topLevelCount === 0 ? '' : 'next item');
      topLevelCount++;
    }
  } catch (error) {
    if (!(error instanceof AnnotationStop)) throw error;
    stop = error;
  }
  return { items, owner, stop, topLevelCount };
}

// ================================================================ the playground

const ENCODE_PRESETS = [
  { label: "The tour's example: { id: 7, name: 'Ada' }", source: "{ id: 7, name: 'Ada' }" },
  { label: 'The README example', source: "{ id: 7, name: 'Ada', tags: ['x', 'y'], active: true, manager: null }" },
  { label: 'Integer widths, up to a bignum', source: '[0, 23, 24, 255, 256, 65535, 65536, 4294967296, -1, -25, 9007199254740993n, 18446744073709551616n]' },
  { label: "Floats (try floats: 'shortest')", source: '[1.5, 0.1, -0, NaN, Infinity, 65504, 3.4028234663852886e38]' },
  { label: 'A COSE key: Map with integer keys', source: 'new Map([\n  [1, 2],      // kty: EC2\n  [3, -7],     // alg: ES256\n  [-1, 1],     // crv: P-256\n  [-2, new Uint8Array([0x65, 0xed, 0xa5, 0xa1, 0x25, 0x77, 0xc2, 0xba, 0xe8, 0x29, 0x43, 0x7f, 0xe3, 0x38, 0x70, 0x1a, 0x10, 0xaa, 0xa3, 0x75, 0xe1, 0xbb, 0x5b, 0x5d, 0xe1, 0x08, 0xde, 0x43, 0x9c, 0x08, 0x55, 0x1d])],\n  [-3, new Uint8Array([0x1e, 0x52, 0xed, 0x75, 0x70, 0x11, 0x63, 0xf7, 0xf9, 0xe4, 0x0d, 0xdf, 0x9f, 0x34, 0x1b, 0x3d, 0xc9, 0xba, 0x86, 0x0a, 0xf7, 0xe0, 0xca, 0x7c, 0xa7, 0xe9, 0xee, 0xcd, 0x00, 0x84, 0xd1, 0x9c])],\n])' },
  { label: 'Dates, bigints and tags', source: "{\n  when: new Date('2026-11-25T09:00:00Z'),\n  big: 18446744073709551616n,\n  link: tagged(32, 'https://github.com/davidgtonge/pure-cbor'),\n}" },
  { label: 'A typed array (RFC 8746 tag)', source: 'new Float64Array([1.25, -0, 3.141592653589793])' },
  { label: 'Keys out of order (try deterministic)', source: "{ zebra: 1, apple: 2, mango: { beta: true, alpha: false } }" },
  { label: 'Unicode text', source: "'naïve café 🎉'" },
  { label: 'Not encodable: an invalid Date', source: 'new Date(NaN)' },
];

const DECODE_PRESETS = [
  { label: 'The tour\'s 14 bytes', hex: 'a2 62 69 64 07 64 6e 61 6d 65 63 41 64 61' },
  { label: 'RFC 8949: indefinite map {_ "Fun": true, "Amt": -2}', hex: 'bf 63 46 75 6e f5 63 41 6d 74 21 ff' },
  { label: 'RFC 8949: epoch date 1(1363896240)', hex: 'c1 1a 51 4b 67 b0' },
  { label: 'RFC 8949: [1, [2, 3], [4, 5]]', hex: '83 01 82 02 03 82 04 05' },
  { label: 'RFC 8949: half-precision 65504.0', hex: 'f9 7b ff' },
  { label: 'A bignum: 2⁶⁴ as tag 2', hex: 'c2 49 01 00 00 00 00 00 00 00 00' },
  { label: 'Text in chunks: (_ "strea", "ming")', hex: '7f 65 73 74 72 65 61 64 6d 69 6e 67 ff' },
  { label: 'Error: a duplicate key', hex: 'a2 61 61 01 61 61 02' },
  { label: 'Error: truncated', hex: 'a2 62 69 64 07 64 6e 61 6d' },
  { label: 'Error: invalid UTF-8', hex: '62 c3 28' },
  { label: 'Error: trailing bytes', hex: '01 02' },
  { label: 'Error: nested 200 deep', hex: '81'.repeat(200) + '00' },
  { label: 'Error: a 4 GB string in 5 bytes', hex: '7a ff ff ff ff' },
];

const MAX_SHOWN_BYTES = 768;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(html, tone) {
  const node = element('span', `pg-chip${tone ? ' ' + tone : ''}`);
  node.innerHTML = html;
  return node;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setUpPlayground(root, library) {
  const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
  const encodePanel = root.querySelector('#pg-encode-panel');
  const decodePanel = root.querySelector('#pg-decode-panel');
  const presetSelect = root.querySelector('#pg-preset');
  const sourceInput = root.querySelector('#pg-source');
  const hexPresetSelect = root.querySelector('#pg-hex-preset');
  const hexInput = root.querySelector('#pg-hex');
  const deterministicInput = root.querySelector('#pg-deterministic');
  const shortestInput = root.querySelector('#pg-shortest');
  const statusArea = root.querySelector('[data-pg-status]');
  const bytesArea = root.querySelector('[data-pg-bytes]');
  const itemsArea = root.querySelector('[data-pg-items]');
  const valueArea = root.querySelector('[data-pg-value] code');
  let mode = 'encode';

  ENCODE_PRESETS.forEach((preset, index) => presetSelect.append(new Option(preset.label, String(index))));
  presetSelect.append(new Option('Your own value', 'custom'));
  DECODE_PRESETS.forEach((preset, index) => hexPresetSelect.append(new Option(preset.label, String(index))));
  hexPresetSelect.append(new Option('Your own bytes', 'custom'));
  sourceInput.value = ENCODE_PRESETS[0].source;
  hexInput.value = DECODE_PRESETS[0].hex;

  // ---------------------------------------------------------------- rendering

  const linkTo = (itemIndex) => {
    for (const node of root.querySelectorAll('.is-linked')) node.classList.remove('is-linked');
    if (itemIndex < 0) return;
    for (const cell of bytesArea.querySelectorAll(`[data-item="${itemIndex}"]`)) cell.classList.add('is-linked');
    const row = itemsArea.querySelector(`[data-item="${itemIndex}"]`);
    if (row) {
      row.classList.add('is-linked');
      const rowTop = row.offsetTop - itemsArea.offsetTop;
      if (rowTop < itemsArea.scrollTop || rowTop > itemsArea.scrollTop + itemsArea.clientHeight - row.offsetHeight) {
        itemsArea.scrollTop = rowTop - itemsArea.clientHeight / 2;
      }
    }
  };

  const renderBytes = (bytes, annotation, errorOffset) => {
    bytesArea.replaceChildren();
    const shown = Math.min(bytes.length, MAX_SHOWN_BYTES);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < shown; index++) {
      const itemIndex = annotation.owner[index];
      const item = annotation.items[itemIndex];
      const cell = element('span', 'pg-byte', bytes[index].toString(16).padStart(2, '0'));
      cell.tabIndex = 0;
      if (item) {
        cell.classList.add(`major-${item.major}`, index < item.headerEnd ? 'is-header' : 'is-payload');
        cell.dataset.item = String(itemIndex);
        cell.title = `byte ${index}: ${item.kind}${item.text ? ' · ' + item.text : ''}`;
      } else {
        cell.classList.add('is-unread');
        cell.title = `byte ${index}: not read`;
      }
      if (index === errorOffset) cell.classList.add('is-error');
      fragment.append(cell);
    }
    if (bytes.length > shown) fragment.append(element('span', 'pg-more', `… ${bytes.length - shown} more bytes`));
    bytesArea.append(fragment);
  };

  const renderItems = (bytes, annotation) => {
    itemsArea.replaceChildren();
    const fragment = document.createDocumentFragment();
    annotation.items.forEach((item, itemIndex) => {
      const row = element('li');
      row.dataset.item = String(itemIndex);
      row.style.setProperty('--depth', String(Math.min(item.depth, 12)));
      const headerHex = hex(bytes, item.start, item.headerEnd);
      const isLeaf = item.major !== 4 && item.major !== 5 && item.major !== 6 && !item.kind.includes('chunks');
      const payloadHex = isLeaf && item.end > item.headerEnd ? ' ' + hex(bytes, item.headerEnd, Math.min(item.end, item.headerEnd + 8)) + (item.end - item.headerEnd > 8 ? '…' : '') : '';
      const hexCell = element('span', `pg-item-hex major-${item.major}`, headerHex + payloadHex);
      const textCell = element('span', 'pg-item-text');
      if (item.role) textCell.append(element('span', 'pg-role', item.role));
      textCell.append(element('span', 'pg-kind', item.kind + (item.text ? ': ' : '')));
      if (item.text) textCell.append(document.createTextNode(item.text));
      if (item.invalid) row.classList.add('is-error');
      row.append(hexCell, textCell);
      fragment.append(row);
    });
    if (annotation.stop) {
      const row = element('li', 'is-error');
      row.style.setProperty('--depth', '0');
      row.append(element('span', 'pg-item-hex', `byte ${annotation.stop.offset}`), element('span', 'pg-item-text', annotation.stop.message));
      fragment.append(row);
    }
    if (annotation.items.length === 0 && !annotation.stop) fragment.append(element('li', 'pg-empty', 'No bytes yet.'));
    itemsArea.append(fragment);
  };

  const describeError = (error) => {
    if (error instanceof library.CborError) {
      return `<strong>CborError</strong> <code>${escapeHtml(error.code)}</code> at byte ${error.offset}: ${escapeHtml(error.message)}`;
    }
    return `<strong>${escapeHtml(error.name || 'Error')}</strong>: ${escapeHtml(error.message)}`;
  };

  const showBytes = (bytes, errorOffset) => {
    const annotation = annotate(bytes);
    renderBytes(bytes, annotation, errorOffset);
    renderItems(bytes, annotation);
  };

  const clearOutput = () => {
    bytesArea.replaceChildren();
    itemsArea.replaceChildren(element('li', 'pg-empty', 'Nothing to show.'));
    valueArea.textContent = '';
  };

  // ---------------------------------------------------------------- the two modes

  const runEncode = () => {
    statusArea.replaceChildren();
    let value;
    try {
      value = parseLiteral(sourceInput.value, library);
    } catch (error) {
      statusArea.append(chip(`<strong>Can't read the value</strong>: ${escapeHtml(error.message)}`, 'bad'));
      clearOutput();
      return;
    }
    const options = {};
    if (deterministicInput.checked) options.deterministic = true;
    if (shortestInput.checked) options.floats = 'shortest';
    let bytes;
    try {
      bytes = library.encode(value, options);
    } catch (error) {
      statusArea.append(chip(`encode threw ${describeError(error)}`, 'bad'));
      clearOutput();
      return;
    }
    const jsonLength = jsonByteLength(value);
    statusArea.append(chip(`<strong>${bytes.length}</strong> byte${bytes.length === 1 ? '' : 's'} of CBOR`, 'good'));
    if (jsonLength !== null) statusArea.append(chip(`${jsonLength} bytes as JSON`));
    showBytes(bytes, -1);
    const result = library.tryDecode(bytes);
    valueArea.textContent = result.ok ? formatValue(result.value, library) : `decode failed: ${result.error.message}`;
  };

  const runDecode = () => {
    statusArea.replaceChildren();
    const cleaned = hexInput.value.replace(/0x/gi, '').replace(/[\s,]/g, '');
    if (/[^0-9a-f]/i.test(cleaned) || cleaned.length % 2 !== 0) {
      statusArea.append(chip('<strong>Not hex</strong>: use pairs of 0–9 and a–f.', 'bad'));
      clearOutput();
      return;
    }
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(cleaned.slice(2 * index, 2 * index + 2), 16);
    const result = library.tryDecode(bytes);
    if (result.ok) {
      statusArea.append(chip(`<strong>Decoded</strong> ${bytes.length} byte${bytes.length === 1 ? '' : 's'}`, 'good'));
      valueArea.textContent = formatValue(result.value, library);
      showBytes(bytes, -1);
    } else {
      statusArea.append(chip(`tryDecode returned ${describeError(result.error)}`, 'bad'));
      valueArea.textContent = `{ ok: false, error: CborError('${result.error.code}') }`;
      showBytes(bytes, result.error.offset);
    }
  };

  const run = () => (mode === 'encode' ? runEncode() : runDecode());

  // ---------------------------------------------------------------- events

  const selectMode = (nextMode, focus) => {
    mode = nextMode;
    for (const tab of tabs) {
      const selected = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    encodePanel.hidden = mode !== 'encode';
    decodePanel.hidden = mode !== 'decode';
    run();
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectMode(tab.dataset.mode, false));
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        selectMode(mode === 'encode' ? 'decode' : 'encode', true);
      }
    });
  }

  presetSelect.addEventListener('change', () => {
    const preset = ENCODE_PRESETS[Number(presetSelect.value)];
    if (preset) sourceInput.value = preset.source;
    run();
  });
  hexPresetSelect.addEventListener('change', () => {
    const preset = DECODE_PRESETS[Number(hexPresetSelect.value)];
    if (preset) hexInput.value = preset.hex.length > 60 && !preset.hex.includes(' ') ? preset.hex.replace(/(..)/g, '$1 ').trim() : preset.hex;
    run();
  });
  let pending = 0;
  const runSoon = (select) => {
    select.value = 'custom';
    window.clearTimeout(pending);
    pending = window.setTimeout(run, 150);
  };
  sourceInput.addEventListener('input', () => runSoon(presetSelect));
  hexInput.addEventListener('input', () => runSoon(hexPresetSelect));
  deterministicInput.addEventListener('change', run);
  shortestInput.addEventListener('change', run);

  const itemOf = (target) => {
    const holder = target.closest('[data-item]');
    return holder ? Number(holder.dataset.item) : -1;
  };
  for (const area of [bytesArea, itemsArea]) {
    area.addEventListener('pointerover', (event) => linkTo(itemOf(event.target)));
    area.addEventListener('focusin', (event) => linkTo(itemOf(event.target)));
    area.addEventListener('pointerleave', () => linkTo(-1));
  }

  run();
}

// ================================================================ the streaming demo

const STREAM_ROWS = ['Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Donald', 'Margaret', 'Ken']
  .map((name, index) => ({ id: index + 1, name, score: Math.round((0.61 + index * 0.047) * 1000) / 1000 }));

function setUpStreamDemo(root, library) {
  const slider = root.querySelector('#stream-chunk');
  const sizeOutput = root.querySelector('#stream-chunk-value');
  const bytesArea = root.querySelector('[data-stream-bytes]');
  const logBody = root.querySelector('[data-stream-log]');
  const summary = root.querySelector('[data-stream-summary]');
  const stepButton = root.querySelector('[data-stream="step"]');
  const allButton = root.querySelector('[data-stream="all"]');
  const resetButton = root.querySelector('[data-stream="reset"]');

  const encodedRows = STREAM_ROWS.map((row) => library.encode(row));
  const sequence = new Uint8Array(encodedRows.reduce((total, bytes) => total + bytes.length, 0));
  const itemRanges = [];
  let offset = 0;
  for (const bytes of encodedRows) {
    sequence.set(bytes, offset);
    itemRanges.push({ start: offset, end: offset + bytes.length });
    offset += bytes.length;
  }
  slider.max = String(Math.min(128, sequence.length));

  let chunkSize = Number(slider.value);
  let decoder;
  let pushedChunks = 0;
  let decodedCount = 0;
  let cells = [];
  let chunkCount = 0;

  const isSplit = (range) => Math.floor(range.start / chunkSize) !== Math.floor((range.end - 1) / chunkSize);

  const render = () => {
    bytesArea.replaceChildren();
    cells = [];
    const fragment = document.createDocumentFragment();
    itemRanges.forEach((range, itemIndex) => {
      const split = isSplit(range);
      for (let index = range.start; index < range.end; index++) {
        const cell = element('span', `stream-byte ${split ? 'is-split' : itemIndex % 2 === 0 ? 'item-a' : 'item-b'}`, sequence[index].toString(16).padStart(2, '0'));
        if (index === range.start) cell.classList.add('item-start');
        if (index === range.end - 1) cell.classList.add('item-end');
        if (index % chunkSize === 0 && index > 0) cell.classList.add('chunk-start');
        cells.push(cell);
        fragment.append(cell);
      }
    });
    bytesArea.append(fragment);
  };

  const reset = () => {
    chunkSize = Number(slider.value);
    sizeOutput.value = String(chunkSize);
    sizeOutput.textContent = String(chunkSize);
    chunkCount = Math.ceil(sequence.length / chunkSize);
    decoder = library.createSequenceDecoder();
    pushedChunks = 0;
    decodedCount = 0;
    logBody.replaceChildren();
    render();
    const splitCount = itemRanges.filter(isSplit).length;
    summary.textContent = `${sequence.length} bytes, ${itemRanges.length} items, ${chunkCount} chunks of up to ${chunkSize} bytes. ${splitCount} item${splitCount === 1 ? ' is' : 's are'} cut by a boundary.`;
    stepButton.disabled = false;
    allButton.disabled = false;
  };

  const pushNext = () => {
    if (pushedChunks >= chunkCount) return;
    const start = pushedChunks * chunkSize;
    const end = Math.min(sequence.length, start + chunkSize);
    const emitted = [];
    let failure = null;
    try {
      decoder.push(sequence.slice(start, end), (value) => emitted.push(value));
    } catch (error) {
      failure = error;
    }
    pushedChunks++;
    decodedCount += emitted.length;
    for (const cell of bytesArea.querySelectorAll('.is-latest')) cell.classList.remove('is-latest');
    for (let index = start; index < end; index++) cells[index].classList.add('is-pushed', 'is-latest');
    for (const row of logBody.querySelectorAll('.is-latest')) row.classList.remove('is-latest');
    const row = element('tr', 'is-latest');
    row.append(
      element('td', '', String(pushedChunks)),
      element('td', '', `${start}–${end - 1}`),
      element('td', emitted.length ? '' : 'muted', failure ? `threw ${failure.message}` : emitted.length ? emitted.map((value) => `#${value.id} ${value.name}`).join(', ') : 'none yet'),
      element('td', 'number', String(decoder.bufferedBytes)),
    );
    logBody.append(row);
    row.scrollIntoView({ block: 'nearest' });
    if (pushedChunks === chunkCount) {
      decoder.end();
      const splitCount = itemRanges.filter(isSplit).length;
      summary.textContent = `end() accepted the input: ${decodedCount} of ${itemRanges.length} values from ${chunkCount} chunks. ${splitCount} item${splitCount === 1 ? ' was' : 's were'} gathered in the assembly buffer; the other ${itemRanges.length - splitCount} were decoded where they lay.`;
      stepButton.disabled = true;
      allButton.disabled = true;
    }
  };

  slider.addEventListener('input', reset);
  stepButton.addEventListener('click', pushNext);
  allButton.addEventListener('click', () => { while (pushedChunks < chunkCount) pushNext(); });
  resetButton.addEventListener('click', reset);
  reset();
}

// ================================================================ start

async function start() {
  const playground = document.querySelector('[data-playground]');
  const streamDemo = document.querySelector('[data-stream-demo]');
  let library;
  try {
    library = await import(LIBRARY_URL);
  } catch {
    for (const root of [playground, streamDemo]) {
      if (!root) continue;
      const message = element('p', 'callout', 'The live demo could not load the library build. Everything else on this page works without it.');
      root.replaceChildren(message);
    }
    return;
  }
  if (playground) setUpPlayground(playground, library);
  if (streamDemo) setUpStreamDemo(streamDemo, library);
  // The demos grow once filled in, which moves everything below them. If the
  // page was opened at a section, put that section back in view.
  const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (target && performance.now() < 2000) target.scrollIntoView({ block: 'start', behavior: 'instant' });
}

start();
