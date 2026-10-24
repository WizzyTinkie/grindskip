import assert from 'node:assert/strict';
import { setImmediate as idle } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { FRAME_SEC } from '../src/controller/controller.js';
import { createAnalysis } from '../src/lookahead/analysis.js';
import { codecsOf, decodable, hasAudio } from '../src/lookahead/codecs.js';
import { fragment, initSegment, lcConfig } from './mp4.js';

describe('codecs', () => {
  test('tell audio buffers, and what look-ahead decodes', () => {
    assert.deepEqual(codecsOf('video/mp4; codecs="avc1.4D401F, mp4a.40.2"'), ['avc1.4D401F', 'mp4a.40.2']);
    assert.deepEqual(codecsOf('audio/mp4'), []);
    assert.equal(hasAudio('audio/mp4'), true);
    assert.equal(hasAudio('video/mp4;codecs="mp4a.40.2"'), true);
    assert.equal(hasAudio('video/mp4;codecs="avc1.4D402A,mp4a.40.2"'), true);
    assert.equal(hasAudio('video/mp4;codecs="avc1.4D401F"'), false);
    assert.equal(hasAudio('video/webm; codecs="vp09.00.30.08"'), false);
    for (const mime of ['audio/webm; codecs="opus"', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4; codecs="mp4a.40.5"', 'video/mp4;codecs="mp4a.40.29"', 'audio/mp4; codecs="opus"', 'video/mp4;codecs="avc1.4D402A,mp4a.40.2"']) {
      assert.equal(decodable(mime), true, mime);
    }
    for (const mime of ['audio/mp4', 'audio/mp4; codecs="ec-3"', 'audio/webm; codecs="vorbis"', 'video/mp4;codecs="avc1.4D401F"', 'video/mp4;codecs="avc1.4D401F,ec-3"', 'audio/mpeg']) {
      assert.equal(decodable(mime), false, mime);
    }
  });
});

// Stand-ins for WebCodecs. Like Chrome's, the decoder's output timestamps
// count on from the first input after a configure or reset; like Firefox's,
// they are the input's. outRate stands for implicit SBR, where the output
// has twice the rate the config says.
class EncodedAudioChunk {
  constructor({ type, timestamp, data }) {
    Object.assign(this, { type, timestamp, data });
  }
}
class AudioDecoder {
  static like = 'chrome';
  static outRate = null;
  static made = [];
  state = 'unconfigured';
  resets = 0;
  #epoch = 0;
  #next = null;
  constructor({ output }) {
    this.output = output;
    AudioDecoder.made.push(this);
  }
  configure(config) {
    this.config = config;
    this.state = 'configured';
    this.#next = null;
  }
  decode(chunk) {
    const rate = AudioDecoder.outRate ?? this.config.sampleRate;
    const n = Math.round(1024 * rate / this.config.sampleRate);
    const timestamp = AudioDecoder.like === 'chrome' ? (this.#next ??= chunk.timestamp) : chunk.timestamp;
    this.#next = timestamp + n / rate * 1e6;
    const epoch = this.#epoch;
    queueMicrotask(() => {
      if (epoch !== this.#epoch || this.state === 'closed') return;
      this.output({ timestamp, numberOfFrames: n, numberOfChannels: 1, sampleRate: rate, copyTo: (dst) => dst.fill(0.1), close() {} });
    });
  }
  reset() {
    this.resets++;
    this.#epoch++;
    this.state = 'unconfigured';
  }
  close() {
    this.state = 'closed';
  }
}
const stream = () => ({ process: async () => 0.5, reset() {} });

// AAC-LC at 44.1 kHz in fragments of `per` samples (1024 ticks each)
const RATE = 44100;
const SEC = 1024 / RATE;
const init = (rateIndex = 4, rate = RATE) => initSegment([{ id: 1, handler: 'soun', timescale: rate, duration: 1024, setup: lcConfig(rateIndex, 2) }]);
const frag = (ticks, per = 86) => fragment([{ id: 1, time: ticks, sizes: Array(per).fill(8) }]);

function analyse(like) {
  AudioDecoder.like = like;
  AudioDecoder.made = [];
  return createAnalysis('audio/mp4;codecs=mp4a.40.2', stream());
}
// Lets the decoder's outputs and the model's promises run
const settle = async () => {
  for (let i = 0; i < 5; i++) await idle();
};

describe('look-ahead analysis', () => {
  before(() => Object.assign(globalThis, { AudioDecoder, EncodedAudioChunk }));
  after(() => {
    delete globalThis.AudioDecoder;
    delete globalThis.EncodedAudioChunk;
  });

  for (const like of ['chrome', 'firefox']) {
    test(`segments overlapping by 22 ms don't add up (${like})`, async () => {
      const a = analyse(like);
      assert.equal(a.supported, true);
      a.push(init(), { init: true });
      // 20 segments of 86 frames (2 s), each starting 22 ms before the last ended
      const overlap = Math.round(0.022 * RATE);
      let ticks = 0;
      for (let k = 0; k < 20; k++) {
        a.push(frag(ticks));
        ticks += 86 * 1024 - overlap;
      }
      await settle();
      const end = (ticks + overlap) / RATE;
      assert.equal(a.error, null);
      assert.ok(Math.abs(a.decodedUntil - end) < 0.002, `decoded until ${a.decodedUntil}, media ends at ${end}`);
      assert.equal(a.counts.steps, 19);
      assert.equal(AudioDecoder.made[0].resets, 0);
      // Analysed up to the end, not beyond it
      assert.ok(a.timeline.ahead(0) > end - 0.1 && a.timeline.ahead(0) < end + FRAME_SEC, `${a.timeline.ahead(0)}`);
    });
  }

  test('media time is the sample\'s time plus timestampOffset, within the append window', async () => {
    const a = analyse('chrome');
    // As video.js appends a TS stream: timestamps from 10 s, offset -10
    a.push(init(), { init: true, offset: -10 });
    a.push(frag(10 * RATE, 100), { offset: -10, windowEnd: 1 });
    await settle();
    assert.ok(Math.abs(a.decodedUntil - Math.floor(1 / SEC + 1) * SEC) < 1e-6, `${a.decodedUntil}`);
    assert.notEqual(a.timeline.at(0.1), undefined);
    assert.equal(a.timeline.at(1.5), undefined);
  });

  test('a jump in the input starts the decoder afresh', async () => {
    const a = analyse('chrome');
    a.push(init(), { init: true });
    a.push(frag(0));
    a.push(frag(100 * RATE));
    await settle();
    assert.equal(AudioDecoder.made[0].resets, 1);
    assert.ok(Math.abs(a.decodedUntil - (100 + 86 * SEC)) < 1e-6, `${a.decodedUntil}`);
    assert.notEqual(a.timeline.at(100.5), undefined);
  });

  test('resamples from the rate the decoder puts out (implicit SBR)', async () => {
    AudioDecoder.outRate = 44100;
    try {
      const a = analyse('firefox');
      // Declared AAC-LC at 22.05 kHz; decoded at 44.1 kHz
      a.push(init(7, 22050), { init: true });
      a.push(fragment([{ id: 1, time: 0, sizes: Array(200).fill(8) }]));
      await settle();
      const sec = 200 * 1024 / 22050;
      assert.ok(Math.abs(a.decodedUntil - sec) < 1e-6);
      assert.ok(Math.abs(a.timeline.size - sec / FRAME_SEC) < 2, `${a.timeline.size} frames for ${sec} s`);
    } finally {
      AudioDecoder.outRate = null;
    }
  });

  test('a new init segment keeps the decoder unless the config changed', () => {
    const a = analyse('chrome');
    a.push(init(), { init: true });
    a.push(frag(0));
    a.push(init(), { init: true });
    assert.equal(AudioDecoder.made.length, 1);
    a.changeType('audio/mp4;codecs=mp4a.40.2');
    a.push(init(3, 48000), { init: true });
    assert.equal(AudioDecoder.made.length, 2);
    assert.equal(AudioDecoder.made[1].config.sampleRate, 48000);
    assert.equal(AudioDecoder.made[0].state, 'closed');
  });
});
