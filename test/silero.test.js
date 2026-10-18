import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import * as ort from 'onnxruntime-web';
import { FRAME, createModel } from '../src/vad/silero.js';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

let model;
before(async () => {
  model = await createModel(ort, readFileSync(new URL('../assets/silero_vad.onnx', import.meta.url)));
});
after(() => model?.release());

// Deterministic test audio: a few tones and some noise, different per frame
function frames(n, seed = 1) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const f = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const t = (k * FRAME + i) / 16000;
      f[i] = 0.2 * Math.sin(2 * Math.PI * (180 + 40 * Math.sin(3 * t)) * t) + 0.05 * (seed / 0x7fffffff - 0.5);
    }
    out.push(f);
  }
  return out;
}

async function run(stream, input) {
  const out = [];
  for (const f of input) out.push(await stream.process(f));
  return out;
}

test('silence is not speech', async () => {
  const ps = await run(model.createStream(), Array.from({ length: 20 }, () => new Float32Array(FRAME)));
  for (const p of ps) assert.ok(p >= 0 && p < 0.1, `${p}`);
});

test('the state carries over from frame to frame', async () => {
  const input = frames(30);
  const a = await run(model.createStream(), input);
  // The same last frame without what came before it scores differently
  const [alone] = await run(model.createStream(), [input.at(-1)]);
  assert.notEqual(alone, a.at(-1));
});

test('streams of one model keep their own state', async () => {
  const x = frames(25, 1);
  const y = frames(25, 99);
  const alone = await run(model.createStream(), x);
  const s1 = model.createStream();
  const s2 = model.createStream();
  // Interleaved and without waiting, as the offscreen document runs them
  const both = await Promise.all(x.flatMap((f, i) => [s1.process(f), s2.process(y[i])]));
  assert.deepEqual(both.filter((_, i) => i % 2 === 0), alone);
});

test('reset starts afresh, and frames queued before it come back as NaN', async () => {
  const input = frames(15);
  const fresh = await run(model.createStream(), input);
  const s = model.createStream();
  const queued = [s.process(input[0]), s.process(input[1])];
  s.reset();
  const after = await run(s, input);
  assert.deepEqual(await Promise.all(queued), [NaN, NaN]);
  assert.deepEqual(after, fresh);
});
