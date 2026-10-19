import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countSaved } from '../src/content/saved.js';

// A video whose position and speed the test sets, firing the events a media
// element would (synchronously here)
class FakeVideo extends EventTarget {
  currentTime = 0;
  #rate = 1;
  get playbackRate() { return this.#rate; }
  set playbackRate(r) {
    this.#rate = r;
    this.dispatchEvent(new Event('ratechange'));
  }
  // Plays `sec` of media in steps of 0.25 s
  play(sec) {
    for (let i = 0; i < sec / 0.25; i++) {
      this.currentTime += 0.25;
      this.dispatchEvent(new Event('timeupdate'));
    }
  }
  seek(t) {
    this.dispatchEvent(new Event('seeking'));
    this.currentTime = t;
    this.dispatchEvent(new Event('timeupdate'));
  }
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('media played at 2.5x saves 60% of it; at 1x nothing', () => {
  const v = new FakeVideo();
  const s = countSaved(v);
  v.play(10);
  near(s.seconds, 0);
  v.playbackRate = 2.5;
  v.play(10);
  near(s.seconds, 6);
  v.playbackRate = 1;
  v.play(5);
  near(s.seconds, 6);
});

test('seeks by the user are not counted, rewinds cost what they jump back', () => {
  const v = new FakeVideo();
  v.playbackRate = 2;
  const s = countSaved(v);
  v.play(4);
  near(s.seconds, 2);
  v.seek(100);
  v.seek(50);
  near(s.seconds, 2);
  s.rewound(1.5);
  v.seek(48.5);
  near(s.seconds, 0.5);
});

test('nothing counts while the user has set the speed', () => {
  const v = new FakeVideo();
  let active = true;
  const s = countSaved(v, () => active);
  v.playbackRate = 2;
  v.play(2);
  active = false;
  v.play(10);
  near(s.seconds, 1);
});

test('take hands over what was saved since the last take, across videos', () => {
  const v = new FakeVideo();
  v.playbackRate = 2;
  const s = countSaved(v);
  v.play(2);
  near(s.take(), 1);
  near(s.take(), 0);
  v.play(2);
  s.newVideo();
  near(s.seconds, 0);
  v.seek(0);               // the new source starts at 0
  v.play(4);
  near(s.seconds, 2);
  near(s.take(), 3);
});

test('stop stops counting', () => {
  const v = new FakeVideo();
  v.playbackRate = 2;
  const s = countSaved(v);
  s.stop();
  v.play(10);
  near(s.seconds, 0);
});
