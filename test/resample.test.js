import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFramer, createResampler } from '../src/vad/resample.js';

function tone(freq, rate, sec) {
  return Float32Array.from({ length: Math.round(rate * sec) }, (_, i) => Math.sin(2 * Math.PI * freq * i / rate));
}

function rms(xs) {
  return Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
}

// Pushes the input in chunks of the given sizes, cycling through them
function resample(input, inRate, chunks = [1440]) {
  const r = createResampler(inRate);
  const out = [];
  for (let i = 0, k = 0; i < input.length; k++) {
    const n = chunks[k % chunks.length];
    out.push(...r.push(input.subarray(i, i + n)));
    i += n;
  }
  return Float32Array.from(out);
}

for (const inRate of [48000, 44100]) {
  test(`${inRate} Hz in gives 16 kHz out`, () => {
    const out = resample(tone(440, inRate, 2), inRate);
    assert.ok(Math.abs(out.length - 32000) <= 40, `${out.length}`);
  });

  test(`${inRate} Hz: speech frequencies pass and frequencies above 8 kHz are filtered out`, () => {
    // Steady part only: skip the filter's start-up
    const level = (f) => rms(resample(tone(f, inRate, 1), inRate).subarray(1000, 15000));
    const ref = Math.SQRT1_2;
    // Within 0.5 dB up to 6 kHz, and below -60 dB at 10 kHz
    for (const f of [200, 1000, 4000, 6000]) assert.ok(Math.abs(level(f) / ref - 1) < 0.06, `${f} Hz: ${level(f)}`);
    assert.ok(level(10000) / ref < 0.001, `10 kHz: ${level(10000)}`);
  });
}

test('the output does not depend on how the input is chunked', () => {
  const input = tone(1234, 48000, 1);
  const a = resample(input, 48000, [1440]);
  const b = resample(input, 48000, [1, 7, 4096, 333, 1440]);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `sample ${i}`);
});

test('the framer emits 512-sample frames and keeps the remainder', () => {
  const f = createFramer(512);
  const frames = [];
  f.push(new Float32Array(700).fill(1), (x) => frames.push(x.slice()));
  assert.equal(frames.length, 1);
  f.push(new Float32Array(400).fill(2), (x) => frames.push(x.slice()));
  assert.equal(frames.length, 2);
  assert.equal(frames[1][187], 1);
  assert.equal(frames[1][188], 2);
  f.reset();
  f.push(new Float32Array(511), (x) => frames.push(x));
  assert.equal(frames.length, 2);
});
