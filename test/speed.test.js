import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { MAX_RATE, NORMAL_RATE, controlSpeed } from '../src/content/speed.js';

// Like a media element: setting playbackRate fires ratechange afterwards
class FakeVideo extends EventTarget {
  #rate = 1;
  get playbackRate() { return this.#rate; }
  set playbackRate(r) {
    this.#rate = r;
    queueMicrotask(() => this.dispatchEvent(new Event('ratechange')));
  }
}
const settle = () => sleep(0);

test('sets the speed, rounded and capped at 4x', async () => {
  const v = new FakeVideo();
  const s = controlSpeed(v);
  s.set(2.5);
  assert.equal(v.playbackRate, 2.5);
  s.set(1.23456);
  assert.equal(v.playbackRate, 1.23);
  s.set(9);
  assert.equal(v.playbackRate, MAX_RATE);
  await settle();
  assert.equal(s.overridden, false);
});

test('steps aside when someone else changes the speed, until resumed', async () => {
  const v = new FakeVideo();
  let seen = null;
  const s = controlSpeed(v, (r) => { seen = r; });
  s.set(2.5);
  await settle();
  v.playbackRate = 1.75;   // the user, in the player's menu
  await settle();
  assert.equal(s.overridden, true);
  assert.equal(seen, 1.75);
  s.set(1);
  assert.equal(v.playbackRate, 1.75);
  s.resume();
  s.set(1);
  assert.equal(v.playbackRate, NORMAL_RATE);
});

test('a speed set by the player while a new source loads is not the user’s', async () => {
  const v = new FakeVideo();
  const s = controlSpeed(v);
  s.set(2.5);
  await settle();
  v.dispatchEvent(new Event('loadstart'));
  v.playbackRate = 1;      // YouTube restoring its own speed for the new video
  await settle();
  assert.equal(s.overridden, false);
  assert.equal(v.playbackRate, 2.5);
});

test('restore goes back to 1x, but leaves a speed the user chose', async () => {
  const v = new FakeVideo();
  const s = controlSpeed(v);
  s.set(2.5);
  s.restore();
  assert.equal(v.playbackRate, 1);

  const w = new FakeVideo();
  const t = controlSpeed(w);
  t.set(2.5);
  await settle();
  w.playbackRate = 2;
  await settle();
  t.restore();
  assert.equal(w.playbackRate, 2);
});

test('normal speed is played just off 1x, and restore goes back to exactly 1x', () => {
  const v = new FakeVideo();
  const s = controlSpeed(v);
  s.set(1);
  assert.equal(v.playbackRate, NORMAL_RATE);
  s.set(2.5);
  s.set(1.001);
  assert.equal(v.playbackRate, NORMAL_RATE);
  s.restore();
  assert.equal(v.playbackRate, 1);
});

test('choosing exactly 1x while Grindskip plays normal speed changes nothing', async () => {
  const v = new FakeVideo();
  const s = controlSpeed(v);
  s.set(1);
  await settle();
  v.playbackRate = 1;
  await settle();
  assert.equal(s.overridden, false);
  s.set(1);
  assert.equal(v.playbackRate, NORMAL_RATE);
});
