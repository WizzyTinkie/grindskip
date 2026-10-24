import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FRAME_SEC } from '../src/controller/controller.js';
import { LOOKAHEAD, createSchedule } from '../src/lookahead/schedule.js';
import { createTimeline } from '../src/lookahead/timeline.js';
import { DEFAULTS } from '../src/shared/settings.js';

const settings = (over = {}) => ({ ...DEFAULTS, ...over });

// A timeline with speech (p 0.9) in the given media intervals and quiet
// (p 0.05) elsewhere, from `from` to `to` seconds
function timeline(speech, to = 60, from = 0) {
  const tl = createTimeline();
  for (let t = from; t < to - 1e-9; t += FRAME_SEC) {
    const mid = t + FRAME_SEC / 2;
    tl.set(t, speech.some(([a, b]) => mid >= a && mid < b) ? 0.9 : 0.05);
  }
  return tl;
}

// What the schedule says at each media time from `from` to `to`, played
// in order
function walk(s, from, to, step = 0.01) {
  const out = [];
  for (let t = from; t < to; t += step) out.push([t, s.at(t)]);
  return out;
}
const firstTalk = (seen, after) => seen.find(([t, w]) => t > after && w === 'talk')?.[0];

describe('timeline', () => {
  test('files frames by media time and says how far it reaches', () => {
    const tl = timeline([], 10);
    assert.equal(tl.at(3.01), 0.05);
    assert.ok(Math.abs(tl.ahead(3) - 7) < FRAME_SEC);
    tl.prune(5);
    assert.equal(tl.at(3), undefined);
    assert.equal(tl.ahead(3), 0);
    assert.equal(tl.span(20, 1), null);
  });
});

describe('look-ahead schedule', () => {
  test('starts at talk speed for the wait, then gameplay', () => {
    const s = createSchedule(timeline([]), settings());
    const seen = walk(s, 0, 3);
    assert.equal(seen[0][1], 'talk');
    const switched = seen.find(([, w]) => w === 'gameplay')[0];
    assert.ok(Math.abs(switched - DEFAULTS.waitSec) < 0.05, `${switched}`);
  });

  test('slows down before speech, by the lead at gameplay speed', () => {
    const s = createSchedule(timeline([[10, 12]]), settings({ playSpeed: 2.5 }));
    const at = firstTalk(walk(s, 0, 11), 5);
    const lead = LOOKAHEAD.leadSec * 2.5;
    assert.ok(Math.abs(at - (10 - lead)) < 0.05, `talk from ${at}, expected ${10 - lead}`);
    // Speech, then the wait at talk speed, then gameplay again
    assert.equal(s.at(11.5), 'talk');
    assert.equal(s.at(12 + DEFAULTS.waitSec - 0.1), 'talk');
    assert.equal(s.at(12 + DEFAULTS.waitSec + 0.1), 'gameplay');
  });

  test('ignores sounds shorter than the minimum run', () => {
    const short = (LOOKAHEAD.minFrames - 2) * FRAME_SEC;
    const s = createSchedule(timeline([[10, 10 + short]]), settings());
    assert.equal(firstTalk(walk(s, 0, 20), 5), undefined);
  });

  test('says nothing where the analysis doesn\'t reach far enough', () => {
    const s = createSchedule(timeline([], 10), settings());
    walk(s, 0, 5);
    assert.equal(s.at(5), 'gameplay');
    assert.equal(s.at(9.9), null);
    assert.equal(s.at(30), null);
  });

  test('starts afresh in the wait state after a reset (a seek)', () => {
    const s = createSchedule(timeline([]), settings());
    walk(s, 0, 20);
    assert.equal(s.at(20), 'gameplay');
    s.reset(40);
    assert.equal(s.at(40), 'talk');
    assert.equal(s.at(40 + DEFAULTS.waitSec + 0.1), 'gameplay');
  });

  test('a jump past what it has covered also starts afresh', () => {
    // Analysed from 0 to 10 s and from 30 s on, as after a seek
    const tl = timeline([], 10);
    for (let t = 30; t < 60; t += FRAME_SEC) tl.set(t, 0.05);
    const s = createSchedule(tl, settings());
    walk(s, 0, 5);
    assert.equal(s.at(5), 'gameplay');
    assert.equal(s.at(35), 'talk');
    assert.equal(s.at(35 + DEFAULTS.waitSec + 0.1), 'gameplay');
  });

  test('higher sensitivity counts quieter speech', () => {
    const tl = createTimeline();
    for (let t = 0; t < 30; t += FRAME_SEC) tl.set(t, t >= 10 && t < 12 ? 0.47 : 0.05);
    assert.equal(firstTalk(walk(createSchedule(tl, settings()), 0, 15), 5), undefined);
    assert.ok(firstTalk(walk(createSchedule(tl, settings({ sensitivity: 1 })), 0, 15), 5) < 10);
  });
});
