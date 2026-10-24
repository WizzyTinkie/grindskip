import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMp4Demuxer, parseAudioSpecificConfig } from '../src/lookahead/fmp4.js';
import { fragment, initSegment, lcConfig } from './mp4.js';

const AUDIO = { id: 1, handler: 'soun', timescale: 44100, duration: 1024 };
const init = initSegment([AUDIO]);
// Three fragments of 10 samples, 1024 ticks each
const frag = (k) => fragment([{ id: 1, time: k * 10 * 1024, sizes: Array.from({ length: 10 }, (_, i) => 20 + i) }]);
const stream = Uint8Array.from([...init, ...frag(0), ...frag(1), ...frag(2)]);

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

test('reads the track and every sample, however the bytes are split', () => {
  for (const sizes of [[stream.length], [1], [7, 3, 266, 1000], [4096]]) {
    const d = createMp4Demuxer();
    const frames = feed(d, stream, sizes);
    const t = d.tracks.get(1);
    assert.equal(t.handler, 'soun');
    assert.equal(t.codec, 'mp4a.40.2');
    assert.equal(t.sampleRate, 44100);
    assert.equal(t.channels, 2);
    assert.deepEqual(Array.from(t.description), Array.from(lcConfig()));
    assert.equal(frames.length, 30, `${sizes}`);
    assert.equal(frames[0].timestamp, 0);
    assert.ok(Math.abs(frames[29].timestamp - 29 * 1024 / 44100) < 1e-9);
    assert.ok(Math.abs(frames[3].duration - 1024 / 44100) < 1e-9);
    // Sample 3 of the second fragment: its size and first bytes
    assert.equal(frames[13].data.length, 23);
    assert.deepEqual(Array.from(frames[13].data.subarray(0, 2)), [1, 3]);
  }
});

test('reads only the sound track of a buffer with video in it', () => {
  const d = createMp4Demuxer();
  const both = Uint8Array.from([
    ...initSegment([{ id: 1, handler: 'vide', timescale: 90000 }, { id: 2, handler: 'soun', timescale: 48000, duration: 1024 }]),
    ...fragment([{ id: 1, time: 0, sizes: [500, 300] }, { id: 2, time: 4800, sizes: [10, 11, 12] }]),
  ]);
  const frames = feed(d, both, [100]);
  assert.equal(d.tracks.get(1).handler, 'vide');
  assert.deepEqual(frames.map((f) => [f.track, f.data.length, f.data[0], f.data[1]]), [[2, 10, 2, 0], [2, 11, 2, 1], [2, 12, 2, 2]]);
  assert.equal(frames[0].timestamp, 0.1);
});

test('after a reset it picks up at the next fragment, keeping the track', () => {
  const d = createMp4Demuxer();
  d.push(init);
  const f1 = frag(1);
  d.reset();
  // Missed the start of fragment 1: from its middle on
  const frames = feed(d, Uint8Array.from([...f1.subarray(40), ...frag(2)]), [100]);
  assert.equal(d.tracks.get(1).codec, 'mp4a.40.2');
  assert.equal(frames.length, 10);
  assert.ok(Math.abs(frames[0].timestamp - 20 * 1024 / 44100) < 1e-9);
});

test('Opus in MP4 comes with an OpusHead; encrypted tracks are marked', () => {
  const opus = createMp4Demuxer();
  opus.push(initSegment([{ id: 1, handler: 'soun', timescale: 48000, codec: 'opus' }]));
  const t = opus.tracks.get(1);
  assert.equal(t.codec, 'opus');
  assert.equal(new TextDecoder().decode(t.description.subarray(0, 8)), 'OpusHead');
  assert.equal(t.description[9], 2);
  assert.equal(new DataView(t.description.buffer).getUint16(10, true), 312);
  assert.equal(new DataView(t.description.buffer).getUint32(12, true), 48000);

  const enc = createMp4Demuxer();
  enc.push(initSegment([{ id: 1, handler: 'soun', timescale: 48000, codec: 'enca' }]));
  assert.equal(enc.tracks.get(1).encrypted, true);
});

test('reads AudioSpecificConfigs, HE-AAC\'s too', () => {
  assert.deepEqual(parseAudioSpecificConfig(Uint8Array.of(0x12, 0x10)), { aot: 2, sampleRate: 44100, channels: 2 });
  assert.deepEqual(parseAudioSpecificConfig(Uint8Array.of(0x11, 0x90)), { aot: 2, sampleRate: 48000, channels: 2 });
  // HE-AAC v1: object type 5, core 24 kHz, stereo, SBR at 48 kHz, then AAC-LC
  assert.deepEqual(parseAudioSpecificConfig(Uint8Array.of(0x2b, 0x11, 0x88, 0x00)), { aot: 5, sampleRate: 48000, channels: 2 });
});
