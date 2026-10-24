// Analyses one audio SourceBuffer's appends before they play: demuxes them
// (webm.js or fmp4.js, by what the init segment is), decodes them with
// WebCodecs' AudioDecoder, resamples to 16 kHz and runs a Silero stream on
// them, filing each frame's speech probability in a timeline by media time
// (timeline.js).
//
// Opus in WebM (YouTube) and AAC or Opus in fragmented MP4 (HLS and DASH
// players, YouTube's AAC streams); for anything else `supported` is false
// and Grindskip listens live instead. A sample's media time is its
// timestamp plus the SourceBuffer's timestampOffset for its append.
//
// The decoder is fed a continuous timeline of its own: Chrome's carries its
// output timestamps on from where it was, whatever the input's, so small
// gaps and overlaps between segments (a few ms to a frame or two) would
// add up. Where the input steps by less than MAX_STEP_SEC, the decoder's
// timeline carries on and the step is kept as a shift back to media time;
// where it jumps further (a seek, missed appends), the decoder starts
// afresh. Where the decoded audio steps, the framer's clock follows; where
// it jumps, so do the resampler, framer and model state.
import { FRAME_SEC } from '../controller/controller.js';
import { FRAME, SAMPLE_RATE } from '../vad/silero.js';
import { createFramer, createResampler } from '../vad/resample.js';
import { decodable } from './codecs.js';
import { createMp4Demuxer } from './fmp4.js';
import { createTimeline } from './timeline.js';
import { createWebmDemuxer } from './webm.js';

// Decoded audio more than this off from where the last ended is a new stretch
const JUMP_SEC = 0.05;
// Less than this off is just rounding
const SLIP_SEC = 0.002;
// Opus frames last at most 120 ms: a longer step between two is a jump.
// So is a step back: by more than a few frames where the samples' durations
// are known (MP4), by any where they aren't (WebM, whose Opus streams are
// continuous).
const MAX_STEP_SEC = 0.15;
const MAX_BACK_SEC = 0.1;
const MAX_BACK_WEBM_SEC = 0.001;

export function canAnalyse(mime) {
  return decodable(mime) && typeof AudioDecoder === 'function';
}

const isWebm = (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;

// The decoder config for the demuxer's first audio track it can decode
function audioTrack(demux) {
  for (const t of demux.tracks.values()) {
    if (t.codec === 'A_OPUS') {
      return { number: t.number, config: { codec: 'opus', sampleRate: t.sampleRate, numberOfChannels: t.channels, ...(t.setup ? { description: t.setup } : {}) } };
    }
    if (t.handler === 'soun' && !t.encrypted && /^(mp4a\.40\.\d+|opus)$/.test(t.codec)) {
      return { number: t.number, config: { codec: t.codec, sampleRate: t.sampleRate, numberOfChannels: t.channels, ...(t.description ? { description: t.description } : {}) } };
    }
  }
  return null;
}
const sameConfig = (a, b) => a.codec === b.codec && a.sampleRate === b.sampleRate && a.numberOfChannels === b.numberOfChannels
  && a.description?.join() === b.description?.join();

// stream: a Silero stream ({ process, reset, release? }) of its own
export function createAnalysis(mime, stream) {
  const timeline = createTimeline();
  let demux = null;
  let Demuxer = null;     // which kind demux is
  let decoder = null;
  let config = null;
  let track = null;
  let last = null;        // the last frame sent: { t, end } in media time, { fed, fedEnd } in the decoder's
  let shifts = [];        // [{ from (decoder time), shift (media - decoder) }], oldest first
  let resampler = null;
  let rate = null;        // the resampler's input rate
  let framer = null;
  let start = 0;          // media time of the current stretch's first frame
  let frames = 0;         // frames analysed in it
  let expected = null;    // where the next decoded audio should start
  let error = null;
  let stopped = false;
  let decodedUntil = null;
  let onAnalysed = null;  // the debug recording's, while one runs
  const counts = { bytes: 0, frames: 0, decoded: 0, gaps: 0, steps: 0 };

  function fail(e) {
    if (error) return;
    error = String(e?.message ?? e);
    console.warn('Grindskip look-ahead:', e);
  }

  // The media time of decoder time d
  function toMedia(d) {
    while (shifts.length > 1 && shifts[1].from <= d + 1e-4) shifts.shift();
    return d + (shifts[0]?.shift ?? 0);
  }

  function onAudio(data) {
    try {
      const t = toMedia(data.timestamp / 1e6);
      const n = data.numberOfFrames;
      counts.decoded++;
      const mono = new Float32Array(n);
      const plane = new Float32Array(n);
      for (let c = 0; c < data.numberOfChannels; c++) {
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += plane[i] / data.numberOfChannels;
      }
      // The decoder's own rate: with implicit SBR it's twice the config's
      if (data.sampleRate !== rate) {
        rate = data.sampleRate;
        resampler = createResampler(rate, SAMPLE_RATE);
        expected = null;
      }
      if (expected === null || Math.abs(t - expected) > JUMP_SEC) {
        resampler.reset();
        framer.reset();
        stream.reset();
        start = t;
        frames = 0;
      } else if (Math.abs(t - expected) > SLIP_SEC) {
        // A gap or overlap between segments: later frames move with it
        start += t - expected;
      }
      expected = t + n / data.sampleRate;
      decodedUntil = expected;
      framer.push(resampler.push(mono), (frame) => {
        const at = start + frames++ * FRAME_SEC;
        const copy = frame.slice();
        stream.process(copy).then((p) => {
          if (!Number.isFinite(p) || stopped) return;
          timeline.set(at, p);
          onAnalysed?.(at, p, copy);
        }, fail);
      });
    } catch (e) {
      fail(e);
    } finally {
      data.close();
    }
  }

  // Drops what's still being decoded and starts the decoder afresh
  function restart() {
    decoder.reset();
    decoder.configure(config);
    last = null;
    shifts = [];
    expected = null;
  }

  // Sets up the decoder for the track the init segment described
  function configure() {
    track = audioTrack(demux);
    if (!track || (config && sameConfig(track.config, config))) return;
    config = track.config;
    decoder?.close();
    decoder = new AudioDecoder({ output: onAudio, error: fail });
    decoder.configure(config);
    framer ??= createFramer(FRAME);
    last = null;
    shifts = [];
    expected = null;
  }

  return {
    timeline,
    get supported() { return canAnalyse(mime); },
    get error() { return error; },
    get decodedUntil() { return decodedUntil; },
    // Bytes received, frames demuxed and decoded, gaps, small steps between
    // segments, and the decoder's queue
    get counts() { return { ...counts, queued: decoder?.decodeQueueSize ?? null, decoder: decoder?.state ?? null }; },
    // fn(at, p, samples) for each frame analysed from now on (the debug
    // recording), or null for none
    tap(fn) {
      onAnalysed = fn;
    },
    // The buffer's type changed (SourceBuffer.changeType); an init segment
    // follows
    changeType(next) {
      mime = next;
    },
    // Bytes appended to the SourceBuffer: init for an init segment, offset
    // the timestampOffset that applied, and the append window
    push(bytes, { init = false, offset = 0, windowStart = 0, windowEnd = Infinity } = {}) {
      if (stopped || error) return;
      try {
        if (init) {
          const kind = isWebm(bytes) ? createWebmDemuxer : createMp4Demuxer;
          if (kind !== Demuxer) {
            Demuxer = kind;
            demux = kind();
          }
          demux.reset({ resync: false });
        }
        if (!demux) return;
        counts.bytes += bytes.length;
        const out = demux.push(bytes);
        counts.frames += out.length;
        configure();
        if (!decoder || !track) return;
        for (const f of out) {
          if (f.track !== track.number) continue;
          const t = f.timestamp + offset;
          // The browser drops what's outside the append window
          if (t < windowStart - 1e-6 || t >= windowEnd) continue;
          let fed = t;
          if (last) {
            const known = Number.isFinite(f.duration);
            const step = t - last.end;
            if (step < -(known ? MAX_BACK_SEC : MAX_BACK_WEBM_SEC) || step > MAX_STEP_SEC) {
              restart();
            } else if (!known) {
              fed = last.fed + (t - last.t);
            } else {
              fed = last.fedEnd;
              if (Math.abs(step) > 1e-4) counts.steps++;
            }
          }
          const shift = t - fed;
          if (!shifts.length || Math.abs(shifts.at(-1).shift - shift) > 1e-6) shifts.push({ from: fed, shift });
          const duration = Number.isFinite(f.duration) ? f.duration : 0;
          last = { t, end: t + duration, fed, fedEnd: fed + duration };
          decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(fed * 1e6), data: f.data }));
        }
      } catch (e) {
        fail(e);
      }
    },
    // Appends were missed or aborted: read on from the next fragment
    gap() {
      counts.gaps++;
      demux?.reset({ resync: true });
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
