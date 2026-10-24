import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { trackVideo } from '../src/content/video.js';

// Stand-ins for the page: videos, and a document that hands the media
// events it catches on the way down to its listeners
function video({ area = 100, paused = true, muted = false } = {}) {
  return { localName: 'video', clientWidth: area, clientHeight: 1, paused, muted, isConnected: true };
}
function page(...videos) {
  const listeners = {};
  return {
    documentElement: {},
    querySelectorAll: () => videos,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type) => { delete listeners[type]; },
    // v starts playing, or its volume or muting changes
    play(v) {
      v.paused = false;
      listeners.play?.({ target: v });
    },
    volume(v, muted) {
      v.muted = muted;
      listeners.volumechange?.({ target: v });
    },
  };
}
const MutationObserver = globalThis.MutationObserver;
before(() => {
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
});
after(() => {
  globalThis.MutationObserver = MutationObserver;
});

function track(doc) {
  const seen = [];
  const stop = trackVideo(doc, (v) => seen.push(v));
  return { seen, stop };
}

test('follows the largest video at first', () => {
  const small = video({ area: 10 });
  const big = video({ area: 500 });
  const { seen, stop } = track(page(small, big));
  assert.deepEqual(seen, [big]);
  stop();
});

test('a muted video that starts playing doesn’t take over from a paused one with sound', () => {
  const main = video({ area: 500 });
  const preview = video({ area: 10, muted: true });
  const doc = page(main, preview);
  const { seen, stop } = track(doc);
  doc.play(preview);
  doc.play(main);
  assert.deepEqual(seen, [main]);
  stop();
});

test('a video with sound takes over from a paused or muted one', () => {
  const ad = video({ area: 500, muted: true, paused: false });
  const main = video({ area: 100 });
  const other = video({ area: 10 });
  const doc = page(ad, main, other);
  const { seen, stop } = track(doc);
  doc.play(main);
  assert.deepEqual(seen, [ad, main]);
  // Not while the followed one plays with sound
  doc.play(other);
  assert.deepEqual(seen, [ad, main]);
  main.paused = true;
  other.paused = true;
  doc.play(other);
  assert.deepEqual(seen, [ad, main, other]);
  stop();
});

test('unmuting a video that plays makes it the one followed', () => {
  const main = video({ area: 500 });
  const clip = video({ area: 10, muted: true });
  const doc = page(main, clip);
  const { seen, stop } = track(doc);
  doc.play(clip);
  doc.volume(clip, false);
  assert.deepEqual(seen, [main, clip]);
  stop();
});

test('a muted video takes over from one that has left the page', () => {
  const main = video({ area: 500 });
  const preview = video({ area: 10, muted: true });
  const doc = page(main, preview);
  const { seen, stop } = track(doc);
  main.isConnected = false;
  doc.play(preview);
  assert.deepEqual(seen, [main, preview]);
  stop();
});
