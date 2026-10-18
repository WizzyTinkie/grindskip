import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORMAT, MAX_SEC, createRecorder, decodePcm } from '../src/content/recorder.js';

const frame = (v) => new Float32Array(512).fill(v);

test('keeps the audio and the decisions frame by frame, and the events between', () => {
  const r = createRecorder({ url: 'https://example.test/' });
  r.frame(frame(0.5), { p: 0.91234567, inferMs: 0.4567, rate: 2.5, mediaTime: 10.12345, state: 'speech', speed: 1 });
  r.event('reset', { reason: 'seek' });
  r.frame(frame(-1), { p: NaN, inferMs: 0.3, rate: 1, mediaTime: 3 });
  assert.equal(r.seconds, 1024 / 16000);

  const rec = JSON.parse(JSON.stringify(r.toJSON()));
  assert.equal(rec.format, FORMAT);
  assert.equal(rec.url, 'https://example.test/');
  assert.deepEqual(rec.frames.p, [0.9123, null]);
  assert.deepEqual(rec.frames.rate, [2.5, 1]);
  assert.deepEqual(rec.frames.mediaTime, [10.123, 3]);
  assert.deepEqual(rec.frames.state, ['speech', null]);
  assert.deepEqual(rec.events, [{ frame: 1, type: 'reset', reason: 'seek' }]);

  const pcm = decodePcm(rec);
  assert.equal(pcm.length, 1024);
  assert.ok(Math.abs(pcm[0] - 0.5) < 1e-4);
  assert.equal(pcm[1023], -1);
});

test('stops adding frames when full', () => {
  const r = createRecorder();
  const f = frame(0);
  const n = Math.round(MAX_SEC * 16000 / 512);
  for (let i = 0; i < n + 10; i++) r.frame(f, { p: 0, rate: 1, mediaTime: i });
  assert.equal(r.full, true);
  assert.equal(r.toJSON().frames.p.length, n);
});
