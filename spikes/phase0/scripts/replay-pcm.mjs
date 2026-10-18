// Replays the 16 kHz audio captured in a browser (run-clips.mjs) through
// Silero under Node:
//   - with the model the browser ran, to check that Node and the browser
//     give the same probabilities on the same audio, so offline replay can
//     stand in for the browser in Phase 3;
//   - with other models, to score them on the browser's own time-stretching.
//
// Usage: node scripts/replay-pcm.mjs chrome|firefox [model ...]
// Writes results/traces-<browser>-replay.json.
import * as ort from 'onnxruntime-web';
import { readFileSync, writeFileSync } from 'node:fs';
import { createSilero, FRAME } from '../lib/silero.js';

ort.env.wasm.numThreads = 1;
const [browserName, ...models] = process.argv.slice(2);
if (!models.length) models.push('silero_vad_v6.2_16k', 'silero_vad_v5.1.2');
// The browser's model first, so the frame offsets are known for the others
models.sort((a, b) => (b === 'silero_vad_v6.2_16k') - (a === 'silero_vad_v6.2_16k'));

const browserTraces = JSON.parse(readFileSync(`results/traces-${browserName}.json`, 'utf8'));
const out = [];
const skips = new Map();

// The browser trace dropped the frames outside the clip; find how many it
// dropped at the start by matching the browser's own model output
function findSkip(probs, kept) {
  let best = { skip: 0, err: Infinity };
  for (let skip = 0; skip + kept.length <= probs.length && skip < 400; skip++) {
    let err = 0;
    for (let k = 0; k < 200; k++) err += Math.abs(probs[skip + k] - kept[k]);
    if (err < best.err) best = { skip, err };
  }
  return best.skip;
}

for (const model of models) {
  const vad = await createSilero(ort, readFileSync(`models/${model}.onnx`));
  for (const t of browserTraces) {
    const wav = readFileSync(`results/pcm-${browserName}/${t.clip}-${t.speed}x.wav`);
    const i16 = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.byteLength));
    const pcm = Float32Array.from(i16, (x) => x / 32768);
    vad.reset();
    const probs = [];
    for (let k = 0; (k + 1) * FRAME <= pcm.length; k++) probs.push(await vad.process(pcm.subarray(k * FRAME, (k + 1) * FRAME)));
    const key = `${t.clip}|${t.speed}`;
    if (model === t.model) skips.set(key, findSkip(probs, t.probs));
    const skip = skips.get(key);
    const kept = probs.slice(skip, skip + t.probs.length);
    if (model === t.model) {
      let maxDiff = 0;
      for (let k = 0; k < kept.length; k++) maxDiff = Math.max(maxDiff, Math.abs(kept[k] - t.probs[k]));
      console.log(`${browserName} ${t.clip} ${t.speed}x ${model}: max |node - browser| = ${maxDiff.toFixed(4)} over ${kept.length} frames`);
    }
    out.push({ ...t, source: `${browserName}-replay`, model, probs: kept.map((p) => Math.round(p * 1000) / 1000) });
  }
  await vad.release();
}

writeFileSync(`results/traces-${browserName}-replay.json`, JSON.stringify(out));
console.log(`wrote results/traces-${browserName}-replay.json`);
