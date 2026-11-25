// Run against the previous release's compiled index.js (or another compatible baseline).
// node bench/compare.mjs /path/to/v0.1.0/dist/index.js
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../dist/index.js';
if (!process.argv[2]) throw new Error('Provide the baseline dist/index.js path');
const old = await import(pathToFileURL(resolve(process.argv[2])).href);
const ms = +(process.env.BENCH_MS ?? 75), rounds = +(process.env.BENCH_ROUNDS ?? 5);
let sink = 0;
function measure(fn, batch) {
  let count = 0;
  const start = performance.now();
  let end;
  do {
    for (let i = 0; i < batch; i++) sink = (sink + fn(count + i)) | 0;
    count += batch;
    end = performance.now();
  } while (end - start < ms);
  return (end - start) * 1e6 / count;
}
function compare(name, methods, batch = 512) {
  const times = methods.map(() => []);
  for (const [, fn] of methods) measure(fn, batch);
  for (let r = 0; r < rounds; r++) {
    // Alternate order to limit warm-up/GC/time drift biases.
    for (let i = 0; i < methods.length; i++) {
      const j = (r + i) % methods.length;
      times[j].push(measure(methods[j][1], batch));
    }
  }
  console.log(name + '\t' + methods.map(([label], i) => `${label}: ${times[i].sort((a,b)=>a-b)[Math.floor(rounds/2)].toFixed(1)} ns`).join('\t'));
}
const cases = [
  ['uint small', Array.from({length:16}, (_,i)=>i)],
  ['int mixed', Array.from({length:16}, (_,i)=>i%2 ? -100000-i : i*100000)],
  ['float64', Array.from({length:16}, (_,i)=>Math.PI*(i+1))],
  ...[4,8,16,24,32,64,4096].map(n=>[`ASCII ${n}`, Array.from({length:16}, (_,i)=>'x'.repeat(n-1)+i.toString(16))]),
  ['Unicode 16', Array.from({length:16}, (_,i)=>'é水😀'.repeat(4)+i.toString(16))],
  ['Float64Array 1 KiB', Array.from({length:16}, (_,i)=>new Float64Array(128).fill(i+0.5))],
];
const consume = x=>typeof x==='number'? x|0 : typeof x==='string'? x.length : x.byteLength;
console.log(`Node ${process.version}; ${rounds} x ${ms} ms; median ns/op; old/new same run`);
const filter = new RegExp(process.env.BENCH_FILTER || ".");
for (const [name, vs] of cases) {
  if (!filter.test(name)) continue;
  const bs = vs.map(old.encode), ps = bs.map(old.binary), cs = bs.map(current.binary);
  const oldBuf = old.binary(new Uint8Array(Math.max(...vs.map(old.maxEncodedSize))));
  const newBuf = current.binary(new Uint8Array(Math.max(...vs.map(current.maxEncodedSize))));
  const pooled = current.createSlabEncoder();
  compare(name+' decode', [
    ['old prepared tuple', i=>consume(old.read(ps[i&15],0)[0])],
    ['new prepared tuple', i=>consume(current.read(cs[i&15],0)[0])],
    ['new readWhole', i=>consume(current.readWhole(cs[i&15]))],
    ['old decode',i=>consume(old.decode(bs[i&15]))],
    ['new decode',i=>consume(current.decode(bs[i&15]))],
  ]);
  compare(name+' encode', [
    ['old owned',i=>{const a=old.encode(vs[i&15]);return a[0]+a.length;}],
    ['new owned',i=>{const a=current.encode(vs[i&15]);return a[0]+a.length;}],
    ['new slab',i=>{const a=pooled(vs[i&15]);return a[0]+a.length;}],
    ['old write',i=>old.write(oldBuf,0,vs[i&15])+oldBuf.bytes[0]],
    ['new write',i=>current.write(newBuf,0,vs[i&15])+newBuf.bytes[0]],
  ]);
}
// Tuple-per-element comparison against the actual flat-array decoder. This is
// deliberately a simple baseline using the same scalar wire representation.
for (const [name, values] of [
  ['number[] 128',Array.from({length:128},(_,i)=>i)],
  ['string[] 128',Array.from({length:128},(_,i)=>`field_${i}`)],
  ['mixed[] 128',Array.from({length:128},(_,i)=>i%2?`field_${i}`:i)],
  ['number[] 10000',Array.from({length:10000},(_,i)=>i)],
]) {
  if (!filter.test(name)) continue;
  const bytes=current.encode(values), b=current.binary(bytes), header=values.length<24?1:values.length<256?2:3;
  const prepared=current.binary(new Uint8Array(current.maxEncodedSize(values)));
  const pooled=current.createSlabEncoder();
  const tupleDecode=(lib,buffer)=>{
    const result=new Array(values.length);
    let p=header;
    for(let i=0;i<result.length;i++){const [v,end]=lib.read(buffer,p);result[i]=v;p=end;}
    return result;
  };
  const oldB=old.binary(bytes);
  const check=a=>a.length+(typeof a[1]==='number'?a[1]|0:a[1].length);
  const batch=values.length>1000?8:128;
  compare(name+' decode',[
    ['old scalar tuple loop',()=>check(tupleDecode(old,oldB))],
    ['new scalar tuple loop',()=>check(tupleDecode(current,b))],
    ['new array direct',()=>check(current.readWhole(b))],
  ],batch);
  compare(name+' encode',[
    ['owned',()=>current.encode(values).length],
    ['slab',()=>pooled(values).length],
    ['prepared',()=>current.write(prepared,0,values)],
  ],batch);
}
console.log('Checksum:', sink);
