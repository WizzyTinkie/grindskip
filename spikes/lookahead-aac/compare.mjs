// Does Silero hear the same in AAC as in Opus? Runs it under Node, at 1x
// as look-ahead does, on two decoded stretches of the same video (from
// decode.mjs --save: YouTube's AAC and Opus streams of BFG1Q7zpNtE), and
// compares the speech probabilities by media time, after finding the
// shift between them.
//
// Usage: node spikes/lookahead-aac/compare.mjs results/<a>.f32 results/<b>.f32
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createFramer, createResampler } from '../../src/vad/resample.js';
import { createModel } from '../../src/vad/silero.js';
import { DIR } from './lib.mjs';

const require = createRequire(new URL('../../eval/package.json', import.meta.url));
const mod = await import(require.resolve('onnxruntime-web'));
const ort = mod.default ?? mod;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
const model = await createModel(ort, readFileSync(join(DIR, '../../assets/silero_vad.onnx')));

async function probabilities(file) {
  const meta = JSON.parse(readFileSync(join(DIR, `${file}.json`), 'utf8'));
  const buf = readFileSync(join(DIR, file));
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const stream = model.createStream();
  const resampler = createResampler(meta.rate, 16000);
  const framer = createFramer(512);
  const frames = [];
  framer.push(resampler.push(pcm), (f) => frames.push(f.slice()));
  const out = [];
  const t0 = performance.now();
  for (let k = 0; k < frames.length; k++) out.push({ m: meta.start + k * 0.032, p: await stream.process(frames[k]) });
  return { out, msPerFrame: (performance.now() - t0) / frames.length };
}

const [fa, fb] = process.argv.slice(2);
const a = await probabilities(fa);
const b = await probabilities(fb);
const at = (list, m) => list[Math.max(0, Math.min(list.length - 1, Math.round((m - list[0].m) / 0.032)))];
const end = Math.min(a.out.at(-1).m, b.out.at(-1).m);
let best = null;
for (let s = -0.1; s <= 0.1001; s += 0.002) {
  const pairs = a.out.filter((x) => x.m > 0.5 && x.m < end - 0.5).map((x) => [x.p, at(b.out, x.m + s).p]);
  const mae = pairs.reduce((sum, [u, v]) => sum + Math.abs(u - v), 0) / pairs.length;
  if (!best || mae < best.mae) best = { shift: s, mae, pairs };
}
const agree = best.pairs.filter(([u, v]) => (u > 0.5) === (v > 0.5)).length / best.pairs.length;
// Speech onsets (crossing 0.5 upwards) in a, and how far the nearest in b is
const onsets = (list) => list.filter((x, i) => i && x.p > 0.5 && list[i - 1].p <= 0.5).map((x) => x.m);
const oa = onsets(a.out.filter((x) => x.m < end));
const ob = onsets(b.out.filter((x) => x.m < end));
const near = oa.map((m) => Math.min(...ob.map((n) => Math.abs(n - best.shift - m))));
console.log(JSON.stringify({
  a: fa,
  b: fb,
  seconds: +(end - 0.5).toFixed(1),
  frames: best.pairs.length,
  shiftSec: +best.shift.toFixed(3),
  meanAbsDiff: +best.mae.toFixed(4),
  agreeOnSpeech: +(agree * 100).toFixed(1),
  speechShare: [+(best.pairs.filter(([u]) => u > 0.5).length / best.pairs.length * 100).toFixed(1), +(best.pairs.filter(([, v]) => v > 0.5).length / best.pairs.length * 100).toFixed(1)],
  onsets: [oa.length, ob.length],
  onsetsWithin32ms: near.filter((d) => d <= 0.033).length,
  onsetsWithin64ms: near.filter((d) => d <= 0.065).length,
  sileroMsPerFrame: +a.msPerFrame.toFixed(2),
}));
