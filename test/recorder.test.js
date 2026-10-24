import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORMAT, MAX_SEC, createRecorder, decodePcm } from '../src/content/recorder.js';

const frame = (v) => new Float32Array(512).fill(v);

// A clock the test moves
function clock() {
  let t = 100;
  return { now: () => t, add: (s) => { t += s; } };
}

test('keeps the audio and the decisions frame by frame, and the events between', () => {
  const c = clock();
  const r = createRecorder({ url: 'https://example.test/' }, c.now);
  r.frame(frame(0.5), { p: 0.91234567, inferMs: 0.4567, rate: 2.5, mediaTime: 10.12345, state: 'speech', speed: 1 });
  c.add(1.5);
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
  assert.deepEqual(rec.events, [{ frame: 1, wall: 1.5, type: 'reset', reason: 'seek' }]);
  assert.equal(rec.lookahead, null);

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
  // Nor what look-ahead analyses from then on
  r.analysed(0, 0.5, f);
  assert.equal(r.toJSON().lookahead, null);
});

test('with look-ahead, keeps the ticks, the status and the analysed frames around what played', () => {
  const c = clock();
  const r = createRecorder({}, c.now);
  // Analysed before the recording started: probabilities only
  r.analysed(0, 0.1);
  r.analysed(0.032, 0.2);
  // Analysed while recording, far ahead of playback too
  for (let k = 2; k < 1100; k++) r.analysed(k * 0.032, k === 5 ? 0.9 : 0.05, frame(k / 1000));
  let calls = 0;
  const status = () => ({ ahead: 20 + calls++ });
  // Two seconds of ticks from 0 s, then a seek to 30 s
  for (let i = 0; i < 67; i++) {
    r.tick({ mediaTime: i * 0.03, rate: 2.5, playing: 2.5, at: 'gameplay', p: 0.05 }, status);
    c.add(0.03);
  }
  c.add(5);   // paused
  r.event('reset', { reason: 'seek' });
  for (let i = 0; i < 10; i++) {
    r.tick({ mediaTime: 30 + i * 0.03, rate: 1, playing: 1.001, at: 'talk', p: 0.9 }, status);
    c.add(0.03);
  }
  // Two seconds of ticks plus 0.3: the pause doesn't count
  assert.ok(Math.abs(r.seconds - (66 + 1 + 9) * 0.03) < 0.26, `${r.seconds}`);

  const rec = JSON.parse(JSON.stringify(r.toJSON()));
  const la = rec.lookahead;
  assert.equal(la.ticks.wall.length, 77);
  assert.deepEqual([la.ticks.rate[0], la.ticks.playing[70], la.ticks.at[70], la.ticks.p[70]], [2.5, 1.001, 'talk', 0.9]);
  assert.deepEqual(la.status.map((x) => x.ahead), [20, 21, 22]);
  assert.equal(rec.events[0].wall, 7.01);
  // Frames from 0 to 2 s plus 3 s ahead, and 30 to 30.3 s with 10 s before
  // and 3 s after, not the rest
  const m = la.frames.mediaTime;
  assert.equal(m[0], 0);
  assert.ok(m.every((t) => t < 5 || (t >= 20 && t < 33.3)), `${m.filter((t) => t >= 5 && (t < 20 || t >= 33.3))}`);
  assert.ok(m.includes(4.96) && !m.includes(4.992) && m.includes(20) && !m.includes(19.968) && m.includes(33.248) && !m.includes(33.28));
  assert.deepEqual(la.frames.p.slice(0, 6), [0.1, 0.2, 0.05, 0.05, 0.05, 0.9]);
  assert.deepEqual(la.frames.audio.slice(0, 3), [false, false, true]);
  // The audio of the frames that have it, in order
  const pcm = decodePcm(rec, { lookahead: true });
  assert.equal(pcm.length, la.frames.audio.filter(Boolean).length * 512);
  assert.ok(Math.abs(pcm[0] - 0.002) < 1e-4);
});

test('a frame analysed again replaces the one before, keeping its audio', () => {
  const r = createRecorder({}, clock().now);
  r.analysed(1, 0.3, frame(0.25));
  r.analysed(1.0001, 0.7);
  r.tick({ mediaTime: 1, rate: 1, playing: 1, at: 'talk', p: 0.7 });
  const la = r.toJSON().lookahead;
  assert.deepEqual([la.frames.mediaTime, la.frames.p, la.frames.audio], [[0.992], [0.7], [true]]);
});
