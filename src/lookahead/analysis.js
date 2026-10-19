// Analyses one audio SourceBuffer's appends before they play: demuxes them
// (webm.js), decodes them with WebCodecs' AudioDecoder, resamples to 16 kHz
// and runs a Silero stream on them, filing each frame's speech probability
// in a timeline by media time (timeline.js).
//
// Only Opus in WebM so far (what YouTube sends Chrome and Firefox); for
// anything else `supported` is false and Grindskip listens live instead.
// Where the input jumps (a seek, missed appends) the decoder starts afresh:
// Chrome's carries on its output timestamps from where it was, whatever
// the input's. Where the decoded audio jumps, so do the resampler, framer
// and model state.
import { FRAME_SEC } from '../controller/controller.js';
import { FRAME, SAMPLE_RATE } from '../vad/silero.js';
import { createFramer, createResampler } from '../vad/resample.js';
import { createTimeline } from './timeline.js';
import { createWebmDemuxer } from './webm.js';

// Decoded audio more than this off from where the last ended is a new stretch
const JUMP_SEC = 0.05;
// Opus frames last at most 120 ms: a longer step between two is a jump
const MAX_STEP_SEC = 0.15;

export function canAnalyse(mime) {
  return /^audio\/webm/i.test(mime) && /opus/i.test(mime) && typeof AudioDecoder === 'function';
}

// stream: a Silero stream ({ process, reset, release? }) of its own
export function createAnalysis(mime, stream) {
  const timeline = createTimeline();
  const demux = createWebmDemuxer();
  let decoder = null;
  let config = null;
  let track = null;
  let lastIn = null;      // the last frame's timestamp sent to the decoder
  let resampler = null;
  let framer = null;
  let start = 0;          // media time of the current stretch's first frame
  let frames = 0;         // frames analysed in it
  let expected = null;    // where the next decoded audio should start
  let error = null;
  let stopped = false;
  let decodedUntil = null;
  const counts = { bytes: 0, frames: 0, decoded: 0, gaps: 0 };

  function fail(e) {
    if (error) return;
    error = String(e?.message ?? e);
    console.warn('Grindskip look-ahead:', e);
  }

  function onAudio(data) {
    try {
      const t = data.timestamp / 1e6;
      const n = data.numberOfFrames;
      counts.decoded++;
      const mono = new Float32Array(n);
      const plane = new Float32Array(n);
      for (let c = 0; c < data.numberOfChannels; c++) {
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += plane[i] / data.numberOfChannels;
      }
      if (expected === null || Math.abs(t - expected) > JUMP_SEC) {
        resampler.reset();
        framer.reset();
        stream.reset();
        start = t;
        frames = 0;
      }
      expected = t + n / data.sampleRate;
      decodedUntil = expected;
      framer.push(resampler.push(mono), (frame) => {
        const at = start + frames++ * FRAME_SEC;
        stream.process(frame.slice()).then((p) => {
          if (Number.isFinite(p) && !stopped) timeline.set(at, p);
        }, fail);
      });
    } catch (e) {
      fail(e);
    } finally {
      data.close();
    }
  }

  // Sets up the decoder for the track the init segment described
  function configure() {
    const t = [...demux.tracks.values()].find((x) => x.codec === 'A_OPUS');
    if (!t || (track && t.setup?.join() === track.setup?.join())) return;
    track = t;
    decoder?.close();
    config = { codec: 'opus', sampleRate: t.sampleRate, numberOfChannels: t.channels };
    if (t.setup) config.description = t.setup;
    decoder = new AudioDecoder({ output: onAudio, error: fail });
    decoder.configure(config);
    resampler = createResampler(t.sampleRate, SAMPLE_RATE);
    framer = createFramer(FRAME);
    expected = null;
    lastIn = null;
  }

  return {
    timeline,
    get supported() { return canAnalyse(mime); },
    get error() { return error; },
    get decodedUntil() { return decodedUntil; },
    // Bytes received, frames demuxed and decoded, gaps, and the decoder's queue
    get counts() { return { ...counts, queued: decoder?.decodeQueueSize ?? null, decoder: decoder?.state ?? null }; },
    // Bytes appended to the SourceBuffer; init for an init segment
    push(bytes, init) {
      if (stopped || error) return;
      try {
        if (init) demux.reset({ resync: false });
        counts.bytes += bytes.length;
        const out = demux.push(bytes);
        counts.frames += out.length;
        configure();
        if (!decoder) return;
        for (const f of out) {
          if (f.track !== track.number) continue;
          if (lastIn !== null && (f.timestamp < lastIn - 0.001 || f.timestamp > lastIn + MAX_STEP_SEC)) {
            // Drops what's still being decoded from before the jump
            decoder.reset();
            decoder.configure(config);
            expected = null;
          }
          lastIn = f.timestamp;
          decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(f.timestamp * 1e6), data: f.data }));
        }
      } catch (e) {
        fail(e);
      }
    },
    // Appends were missed or aborted: read on from the next cluster
    gap() {
      counts.gaps++;
      demux.reset({ resync: true });
    },
    stop() {
      stopped = true;
      try {
        decoder?.close();
      } catch { /* already closed */ }
      stream.release?.();
    },
  };
}
