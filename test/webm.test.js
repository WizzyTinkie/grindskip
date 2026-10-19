import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebmDemuxer } from '../src/lookahead/webm.js';

// A minimal WebM writer: elements with known sizes, except the Segment and
// Clusters, which YouTube's streams leave open (unknown size)
const UNKNOWN = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
function id(n) {
  const out = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
}
function size(n) {
  return n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff];
}
function el(n, ...children) {
  const body = children.flatMap((c) => Array.from(c));
  return Uint8Array.from([...id(n), ...size(body.length), ...body]);
}
const open = (n, ...children) => Uint8Array.from([...id(n), ...UNKNOWN, ...children.flatMap((c) => Array.from(c))]);
const num = (n, bytes = 1) => Uint8Array.from({ length: bytes }, (_, i) => (n >> (8 * (bytes - 1 - i))) & 0xff);
const f32 = (x) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x);
  return b;
};
const text = (s) => new TextEncoder().encode(s);
// An unlaced SimpleBlock on track 1, `rel` ms after its cluster
const simpleBlock = (rel, payload) => el(0xa3, Uint8Array.of(0x81, (rel >> 8) & 0xff, rel & 0xff, 0x80, ...payload));

const init = Uint8Array.from([
  ...el(0x1a45dfa3, el(0x4282, text('webm'))),
  ...open(0x18538067,
    el(0x1549a966, el(0x2ad7b1, num(1000000, 3))),
    el(0x1654ae6b, el(0xae,
      el(0xd7, num(1)),
      el(0x86, text('A_OPUS')),
      el(0x63a2, text('OpusHead')),
      el(0xe1, el(0xb5, f32(48000)), el(0x9f, num(2))))),
  ),
]);
// Clusters every second, with a 20 ms frame every 20 ms
const cluster = (sec) => open(0x1f43b675, el(0xe7, num(sec * 1000, 2)),
  ...Array.from({ length: 50 }, (_, k) => simpleBlock(k * 20, [sec, k])));
const stream = Uint8Array.from([...init, ...cluster(0), ...cluster(1), ...cluster(2)]);

// Feeds bytes in chunks of the given sizes, cycling
function feed(d, bytes, sizes) {
  const frames = [];
  for (let i = 0, k = 0; i < bytes.length; k++) {
    const n = sizes[k % sizes.length];
    frames.push(...d.push(bytes.subarray(i, i + n)));
    i += n;
  }
  return frames;
}

test('reads the track and every frame, however the bytes are split', () => {
  for (const sizes of [[stream.length], [1], [7, 3, 266, 1000], [4096]]) {
    const d = createWebmDemuxer();
    const frames = feed(d, stream, sizes);
    assert.deepEqual(d.tracks.get(1), { number: 1, codec: 'A_OPUS', setup: text('OpusHead'), sampleRate: 48000, channels: 2 });
    assert.equal(frames.length, 150, `${sizes}`);
    assert.equal(frames[0].timestamp, 0);
    assert.ok(Math.abs(frames[149].timestamp - 2.98) < 1e-9);
    assert.deepEqual(Array.from(frames[51].data), [1, 1]);
  }
});

test('after a reset it picks up at the next cluster, keeping the track', () => {
  const d = createWebmDemuxer();
  d.push(init);
  const c1 = cluster(1);
  d.reset();
  // Missed the start of cluster 1: from its middle on
  const frames = feed(d, Uint8Array.from([...c1.subarray(200), ...cluster(2)]), [100]);
  assert.equal(d.tracks.get(1).codec, 'A_OPUS');
  assert.equal(frames.length, 50);
  assert.equal(frames[0].timestamp, 2);
});

test('laced blocks are counted and skipped', () => {
  const d = createWebmDemuxer();
  const laced = el(0xa3, Uint8Array.of(0x81, 0, 0, 0x82, 1, 2, 3));
  const frames = d.push(Uint8Array.from([...init, ...open(0x1f43b675, el(0xe7, num(0, 2)), laced, simpleBlock(20, [9]))]));
  assert.equal(d.laced, 1);
  assert.equal(frames.length, 1);
});
