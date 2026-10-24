import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLagMeter } from '../src/lookahead/lag.js';

// The video's position over time when a change from r0 to r1, made at
// wall time w0 with the video at m0, takes `lag` seconds to take effect;
// sampled every 30 ms, with a little jitter
function play(meter, { w0 = 10, m0 = 100, r0 = 2.5, r1 = 1.001, lag, jitter = 0.003 }) {
  meter.changed(w0, m0, r0, r1);
  let k = 0;
  for (let w = w0; w <= w0 + 1.5; w += 0.03) {
    const m = w < w0 + lag ? m0 + r0 * (w - w0) : m0 + r0 * lag + r1 * (w - w0 - lag);
    meter.sample(w, m + (k++ % 2 ? jitter : -jitter));
  }
}

test('measures the time a speed change takes to take effect', () => {
  for (const lag of [0, 0.04, 0.3]) {
    const meter = createLagMeter();
    play(meter, { lag });
    assert.ok(Math.abs(meter.last - lag) < 0.01, `${meter.last} for ${lag}`);
  }
});

test('speeding up too', () => {
  const meter = createLagMeter();
  play(meter, { r0: 1.001, r1: 2.5, lag: 0.25 });
  assert.ok(Math.abs(meter.last - 0.25) < 0.01, `${meter.last}`);
});

test('the estimate is the largest of the last few', () => {
  const meter = createLagMeter();
  assert.equal(meter.estimate, null);
  for (const lag of [0.1, 0.3, 0.2]) play(meter, { lag });
  assert.ok(Math.abs(meter.estimate - 0.3) < 0.01);
  for (let i = 0; i < 5; i++) play(meter, { lag: 0.1 });
  assert.ok(Math.abs(meter.estimate - 0.1) < 0.01);
});

test('a seek or a pause during the measurement spoils it', () => {
  const meter = createLagMeter();
  meter.changed(10, 100, 2.5, 1.001);
  for (let w = 10; w <= 11.5; w += 0.03) meter.sample(w, w < 10.8 ? 100 + (w - 10) : 200);
  assert.equal(meter.estimate, null);
  meter.changed(10, 100, 2.5, 1.001);
  meter.reset();
  for (let w = 10; w <= 11.5; w += 0.03) meter.sample(w, 100 + (w - 10));
  assert.equal(meter.estimate, null);
});

test('a measurement from before counts until new ones push it out, and new ones are reported', () => {
  const seen = [];
  const meter = createLagMeter((x) => seen.push(x));
  meter.seed(0.4);
  assert.equal(meter.estimate, 0.4);
  meter.seed(0.9);
  assert.equal(meter.estimate, 0.4, 'only before any measurement');
  for (let i = 0; i < 5; i++) play(meter, { lag: 0.1 });
  assert.ok(Math.abs(meter.estimate - 0.1) < 0.01);
  assert.equal(seen.length, 5);
});
