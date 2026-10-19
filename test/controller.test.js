import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FRAME_SEC, PARAMS, createController, minSpeechFrames, startThreshold } from '../src/controller/controller.js';
import { DEFAULTS } from '../src/shared/settings.js';
import { combine, score } from '../eval/lib/simulate.js';
import { BROWSERS, CLIPS, replay } from './traces.js';

const settings = (over = {}) => ({ ...DEFAULTS, ...over });
const framesIn = (sec) => Math.round(sec / FRAME_SEC);

// Feeds probabilities at a fixed rate; returns the last result
function feed(c, ps, { rate = 1, media = { t: 10 } } = {}) {
  let r;
  for (const p of ps) {
    media.t += FRAME_SEC * rate;
    r = c.frame({ p, rate, mediaTime: media.t });
  }
  return r;
}
const repeat = (p, n) => Array(n).fill(p);

// Brings a fresh controller with the default wait to the gameplay state
function toGameplay(c, opts) {
  const r = feed(c, repeat(0, framesIn(DEFAULTS.waitSec)), opts);
  assert.equal(r.state, 'gameplay');
  return r;
}

describe('start threshold', () => {
  test('is 0.5 at 1x, 0.9 from 2x up, and interpolated in between', () => {
    assert.equal(startThreshold(1), 0.5);
    assert.equal(startThreshold(0.75), 0.5);
    assert.ok(Math.abs(startThreshold(1.5) - 0.7) < 1e-9);
    assert.equal(startThreshold(2), 0.9);
    assert.equal(startThreshold(4), 0.9);
  });

  test('sensitivity moves it by 0.05 a step, staying above the end threshold', () => {
    assert.ok(Math.abs(startThreshold(1, 2) - 0.4) < 1e-9);
    assert.ok(Math.abs(startThreshold(2.5, 2) - 0.8) < 1e-9);
    assert.ok(Math.abs(startThreshold(2.5, -1) - 0.95) < 1e-9);
    assert.ok(startThreshold(1, 10) >= PARAMS.end + PARAMS.minHysteresis - 1e-9);
    assert.ok(startThreshold(4, -10) <= PARAMS.maxStart);
  });
});

describe('controller', () => {
  test('starts in the wait state at talk speed, then speeds up after the wait', () => {
    const c = createController(settings());
    assert.equal(c.state, 'wait');
    assert.equal(c.speed, 1);
    let r = feed(c, repeat(0, framesIn(1.5) - 1));
    assert.equal(r.state, 'wait');
    r = feed(c, [0]);
    assert.equal(r.state, 'gameplay');
    assert.equal(r.speed, 2.5);
  });

  test('below 3x, one frame above the gameplay-speed threshold is speech', () => {
    const c = createController(settings());
    toGameplay(c, { rate: 2.5 });
    // 0.85 is speech at talk speed but not at 2.5x
    assert.equal(feed(c, repeat(0.85, 10), { rate: 2.5 }).state, 'gameplay');
    const r = feed(c, [0.95], { rate: 2.5 });
    assert.equal(r.state, 'speech');
    assert.equal(r.speed, 1);
  });

  test('from 3x up, it takes two frames in a row', () => {
    assert.equal(minSpeechFrames(2.75), 1);
    assert.equal(minSpeechFrames(3), 2);
    const c = createController(settings({ playSpeed: 4 }));
    toGameplay(c, { rate: 4 });
    assert.equal(feed(c, [0.95, 0.1, 0.95, 0.1, 0.95], { rate: 4 }).state, 'gameplay');
    const r = feed(c, [0.95], { rate: 4 });
    assert.equal(r.state, 'speech');
    assert.equal(r.speed, 1);
  });

  test('uses the threshold of the faster rate while a speed change settles', () => {
    const c = createController(settings());
    toGameplay(c, { rate: 1 });
    // The audio still plays at 1x, but the controller has asked for 2.5x
    const r = feed(c, repeat(0.85, 5), { rate: 1 });
    assert.equal(r.state, 'gameplay');
    assert.equal(r.start, PARAMS.startHigh);
  });

  test('keeps talk speed between the end and start thresholds', () => {
    const c = createController(settings());
    feed(c, [0.9]);
    assert.equal(c.state, 'speech');
    assert.equal(feed(c, repeat(0.4, 200)).state, 'speech');
    assert.equal(feed(c, [0.3]).state, 'wait');
  });

  test('a pause shorter than the wait stays at talk speed', () => {
    const c = createController(settings({ waitSec: 1 }));
    feed(c, [0.9]);
    let r = feed(c, repeat(0.1, framesIn(1) - 2));
    assert.equal(r.state, 'wait');
    assert.equal(r.speed, 1);
    r = feed(c, [0.6]);
    assert.equal(r.state, 'speech');
    // One frame to leave speech, then the whole wait
    r = feed(c, repeat(0.1, framesIn(1)));
    assert.equal(r.state, 'wait');
    r = feed(c, [0.1]);
    assert.equal(r.state, 'gameplay');
  });

  test('takes new settings without losing its state', () => {
    const c = createController(settings());
    toGameplay(c);
    c.configure(settings({ playSpeed: 3, talkSpeed: 1.25 }));
    assert.equal(c.state, 'gameplay');
    assert.equal(c.speed, 3);
    feed(c, repeat(0.95, minSpeechFrames(3)), { rate: 3 });
    assert.equal(c.speed, 1.25);
  });

  test('reset goes back to the wait state', () => {
    const c = createController(settings());
    toGameplay(c);
    c.reset({ seek: true });
    assert.equal(c.state, 'wait');
    assert.equal(c.speed, 1);
  });
});

describe('rewind on speech', () => {
  // A controller that has been at gameplay speed for `sec` seconds
  function atGameplayFor(sec, over = {}) {
    const c = createController(settings({ rewind: true, ...over }));
    const media = { t: 100 };
    toGameplay(c, { rate: 2.5, media });
    feed(c, repeat(0, framesIn(sec)), { rate: 2.5, media });
    return { c, media };
  }

  test('jumps back to just before the frames that started the speech', () => {
    const { c, media } = atGameplayFor(5);
    const before = media.t;
    const r = feed(c, repeat(0.95, PARAMS.minSpeechFrames), { rate: 2.5, media });
    assert.equal(r.state, 'speech');
    // The run's first frame began one frame (at 2.5x) after `before`
    assert.ok(Math.abs(r.rewindTo - (before - PARAMS.rewindMarginSec)) < 1e-9, `${r.rewindTo} vs ${before}`);
    assert.ok(media.t - r.rewindTo <= PARAMS.rewindMaxSec);
  });

  test('is off by default', () => {
    const { c, media } = atGameplayFor(5, { rewind: false });
    assert.equal(feed(c, repeat(0.95, PARAMS.minSpeechFrames), { rate: 2.5, media }).rewindTo, null);
  });

  test('never jumps back more than 1.5 s', () => {
    const c = createController(settings({ rewind: true }), { ...PARAMS, minSpeechFrames: 20 });
    const media = { t: 100 };
    toGameplay(c, { rate: 2.5, media });
    feed(c, repeat(0, framesIn(5)), { rate: 2.5, media });
    const r = feed(c, repeat(0.9, 20), { rate: 2.5, media });
    assert.ok(Math.abs(media.t - r.rewindTo - PARAMS.rewindMaxSec) < 1e-9);
  });

  test('only after a few seconds at gameplay speed', () => {
    const { c, media } = atGameplayFor(1);
    const r = feed(c, repeat(0.95, PARAMS.minSpeechFrames), { rate: 2.5, media });
    assert.equal(r.state, 'speech');
    assert.equal(r.rewindTo, null);
  });

  test('not right after a seek', () => {
    const c = createController(settings({ rewind: true }));
    const media = { t: 100 };
    c.reset({ seek: true });
    toGameplay(c, { rate: 2.5, media });
    feed(c, repeat(0, framesIn(PARAMS.rewindAfterSeekSec - 2)), { rate: 2.5, media });
    assert.ok(framesIn(DEFAULTS.waitSec) + framesIn(PARAMS.rewindAfterSeekSec - 2) < framesIn(PARAMS.rewindAfterSeekSec));
    assert.equal(feed(c, repeat(0.95, PARAMS.minSpeechFrames), { rate: 2.5, media }).rewindTo, null);
  });

  test('not without a media time', () => {
    const c = createController(settings({ rewind: true }));
    for (let i = 0; i < framesIn(10); i++) c.frame({ p: 0, rate: 2.5 });
    let r;
    for (let i = 0; i < PARAMS.minSpeechFrames; i++) r = c.frame({ p: 0.95, rate: 2.5 });
    assert.equal(r.state, 'speech');
    assert.equal(r.rewindTo, null);
  });
});

// Closed-loop replay on the Phase 0 clips (see traces.js), with the default
// settings. The bounds sit a little below what the starting thresholds
// reach, so a change that makes things clearly worse fails here; the real
// tuning runs on the Phase 3 recordings (eval/).
describe('replay on recorded traces', () => {
  const run = (browser, params) => combine(CLIPS.map((clip) => {
    const { frames, intervals } = replay(browser, clip, settings(), params);
    return score(frames, intervals, settings());
  }));

  for (const browser of BROWSERS) {
    test(`${browser}: commentary at talk speed, quiet gameplay fast, no false slowdowns`, () => {
      const s = run(browser);
      assert.ok(s.speechAtTalkSpeed >= 0.95, `speech at talk speed ${s.speechAtTalkSpeed}`);
      assert.ok(s.quietAtGameplaySpeed >= 0.9, `quiet at gameplay speed ${s.quietAtGameplaySpeed}`);
      assert.ok(s.falseSlowdownsPerMin <= 0.5, `${s.falseSlowdowns} false slowdowns in ${s.quietMin.toFixed(1)} quiet minutes`);
      assert.ok(s.medianDelay <= 0.4, `median delay ${s.medianDelay}`);
    });
  }

  test('a flat 0.5 start threshold would slow down on sped-up game sound', () => {
    // The reason the start threshold rises with the speed (Phase 0, spike 2)
    const flat = BROWSERS.map((b) => run(b, { ...PARAMS, startHigh: 0.5 }).falseSlowdowns);
    const rising = BROWSERS.map((b) => run(b).falseSlowdowns);
    assert.ok(flat.reduce((a, b) => a + b) > 2 * rising.reduce((a, b) => a + b) + 2, `${flat} vs ${rising}`);
  });
});
