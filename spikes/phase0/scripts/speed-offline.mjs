// Spike 2, offline half: Silero speech probabilities on real commentary
// time-stretched with ffmpeg (atempo, pitch kept, like the browsers do).
//
// Each clip is stretched to every speed, decoded at 48 kHz mono and run
// through the same 16 kHz resampler and Silero session as the extension.
// The traces are written to results/traces-ffmpeg.json for analyze.mjs.
//
// Usage: node scripts/speed-offline.mjs [model ...]
import * as ort from 'onnxruntime-web';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createSilero, FRAME, SAMPLE_RATE } from '../lib/silero.js';
import { createResampler, createFramer } from '../lib/resample.js';
import { CLIPS, CLIP_SEC } from '../lib/clips.mjs';

ort.env.wasm.numThreads = 1;

const MODELS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['silero_vad_v5.1.2', 'silero_vad_v6.2', 'silero_vad_v6.2_16k'];
const SPEEDS = [1, 1.5, 2, 2.5, 3, 4];
const FRAME_SEC = FRAME / SAMPLE_RATE;

function decode(file, speed) {
  const af = speed === 1 ? 'anull' : `atempo=${speed}`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-t', String(CLIP_SEC),
    '-af', af, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

async function trace(vad, pcm48k) {
  vad.reset();
  const resampler = createResampler(48000);
  const framer = createFramer(FRAME);
  const frames = [];
  for (let i = 0; i < pcm48k.length; i += 1440) {
    framer.push(resampler.push(pcm48k.subarray(i, i + 1440)), (f) => frames.push(f.slice()));
  }
  const probs = new Float32Array(frames.length);
  const t0 = performance.now();
  for (let k = 0; k < frames.length; k++) probs[k] = await vad.process(frames[k]);
  return { probs, msPerFrame: (performance.now() - t0) / frames.length };
}

const traces = [];
for (const model of MODELS) {
  const vad = await createSilero(ort, readFileSync(`models/${model}.onnx`));
  for (const clip of CLIPS) {
    for (const speed of SPEEDS) {
      const { probs, msPerFrame } = await trace(vad, decode(clip.file, speed));
      traces.push({
        source: 'ffmpeg', model, clip: clip.name, speed, msPerFrame,
        // media time at the end of each frame
        mediaEnd: Array.from(probs, (_, k) => +((k + 1) * FRAME_SEC * speed).toFixed(4)),
        probs: Array.from(probs, (p) => Math.round(p * 1000) / 1000),
      });
      console.log(`${model.padEnd(20)} ${clip.name.padEnd(7)} ${String(speed).padEnd(4)} ${probs.length} frames, ${msPerFrame.toFixed(3)} ms/frame`);
    }
  }
  await vad.release();
}

mkdirSync('results', { recursive: true });
writeFileSync('results/traces-ffmpeg.json', JSON.stringify(traces));
console.log('wrote results/traces-ffmpeg.json; score it with scripts/analyze.mjs');
