import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRAME_SEC, minSpeechFrames } from '../src/controller/controller.js';
import { DEFAULTS } from '../src/shared/settings.js';
import { combine, score, simulate, source } from '../eval/lib/simulate.js';

// A recording of `sec` seconds of media at `speed`, with speech in the
// given intervals (p 0.95) and silence elsewhere (p 0.02)
function recording(speed, speechIntervals, sec = 60) {
  const n = Math.floor(sec / (FRAME_SEC * speed));
  const media = Float64Array.from({ length: n }, (_, k) => (k + 1) * FRAME_SEC * speed);
  const p = Float32Array.from(media, (m) => (speechIntervals.some(([a, b]) => m > a && m <= b) ? 0.95 : 0.02));
  return source(media, p);
}

const speech = [[20, 25], [40, 41]];
const sources = { 1: recording(1, speech), 2.5: recording(2.5, speech) };

test('a speed change reaches the audio two frames after the decision', () => {
  const frames = simulate(sources, DEFAULTS);
  const i = frames.findIndex((f) => f.state === 'gameplay');
  assert.deepEqual(frames.slice(i, i + 4).map((f) => f.speed), [1, 1, 1, 2.5]);
});

test('media advances at the speed being played, and rewinds jump back', () => {
  const plain = simulate(sources, DEFAULTS);
  const rewound = simulate(sources, { ...DEFAULTS, rewind: true });
  const k = rewound.findIndex((f) => f.rewindTo !== null);
  assert.ok(k > 0);
  assert.ok(rewound[k + 1].media < rewound[k].media);
  assert.ok(rewound.length > plain.length);
});

test('clean speech scores perfectly, with rewind', () => {
  // Without rewind each onset at gameplay speed loses about 0.3 s of media
  // at 2.5x: the frame that detects it, and 3 until the speed change lands
  // (the 2-frame lag and the frame it's decided in)
  const plain = score(simulate(sources, DEFAULTS), speech, DEFAULTS);
  const lost = (minSpeechFrames(2.5) + 3) * FRAME_SEC * 2.5;
  assert.ok(Math.abs(plain.speechAtTalkSpeed - (1 - 2 * lost / 6)) < 0.03, `${plain.speechAtTalkSpeed}`);

  const settings = { ...DEFAULTS, rewind: true };
  const s = score(simulate(sources, settings), speech, settings);
  assert.equal(s.speechAtTalkSpeed, 1);
  assert.equal(s.falseSlowdowns, 0);
  assert.equal(s.missed, 0);
  assert.equal(s.delays.length, 2);
  assert.ok(s.quietAtGameplaySpeed > 0.95, `${s.quietAtGameplaySpeed}`);
  const all = combine([s, s]);
  assert.equal(all.speechAtTalkSpeed, 1);
  assert.ok(all.medianDelay <= 0.2);
});

test('speech nobody labelled counts as a false slowdown', () => {
  const s = score(simulate(sources, DEFAULTS), [[20, 25]], DEFAULTS);
  assert.equal(s.falseSlowdowns, 1);
});
