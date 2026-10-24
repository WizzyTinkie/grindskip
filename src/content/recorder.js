// Debug recording: keeps what Grindskip heard and decided, so that a
// session can be replayed offline with other thresholds or another model.
// Started and saved by the user; nothing leaves the computer unless they
// share the file.
//
// Listening live, that's the 16 kHz audio the detector heard, its
// probabilities and the controller's decisions, frame by frame (`frames`
// and `pcm`; eval/run.mjs replays these). With look-ahead (`lookahead`):
// - the analysed frames by media time, with their probabilities and 16 kHz
//   audio at 1x. The analysis runs ahead of playback, so the file keeps
//   those around what played: from KEEP_BEHIND_SEC before (for a replay to
//   bring the schedule to the state it was in) to KEEP_AHEAD_SEC after.
//   Frames analysed before the recording started have their probability
//   but no audio;
// - every tick of the schedule while the video plays: media time, the speed
//   asked for and the speed playing, the schedule's answer and the
//   probability at the playing position;
// - about once a second, the analysis's status: how far it reaches, how
//   long speed changes take, its counts and errors.
// Events (resets, seeks, mode changes, overrides) carry the live frame they
// came before and the seconds since the recording started.
import { FRAME_SEC } from '../controller/controller.js';
import { FRAME, SAMPLE_RATE } from '../vad/silero.js';

export const FORMAT = 'grindskip-recording';
export const MAX_SEC = 600;
const MAX_FRAMES = Math.round(MAX_SEC * SAMPLE_RATE / FRAME);
// Analysed audio held while recording, at most: what plays in MAX_SEC and
// as much again ahead of it
const MAX_ANALYSED = 2 * MAX_FRAMES;
// What's kept of the analysed frames beyond what played: the schedule looks
// this far ahead of the playing position, and its state depends on about
// this much before (the wait after speech, and more)
const KEEP_AHEAD_SEC = 3;
export const KEEP_BEHIND_SEC = 10;
const STATUS_SEC = 1;
// A longer step between ticks is a pause (or the page was in the background)
const MAX_TICK_SEC = 0.25;

const round = (x, d) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const toInt16 = (samples) => {
  const i16 = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  return i16;
};

// info: anything worth keeping about where and how it was recorded;
// now(): the clock, in seconds
export function createRecorder(info = {}, now = () => performance.now() / 1000) {
  const created = new Date().toISOString();
  const t0 = now();
  const wall = () => round(now() - t0, 3);
  const pcm = [];
  const cols = { p: [], inferMs: [], rate: [], mediaTime: [], state: [], speed: [] };
  const events = [];
  let n = 0;

  const analysed = new Map();  // frame index -> { p, audio: Int16Array | null }
  let audioFrames = 0;
  const ticks = { wall: [], mediaTime: [], rate: [], playing: [], at: [], p: [] };
  const statuses = [];
  let lastTick = null;
  let lastStatus = -Infinity;
  let lookSec = 0;             // played in look-ahead mode

  const seconds = () => n * FRAME / SAMPLE_RATE + lookSec;

  // The analysed frames around what played: by media time, each run of
  // ticks without a seek, with what came before it and what the schedule
  // looked at ahead of it
  function playedFrames() {
    const runs = [];
    for (let i = 0; i < ticks.mediaTime.length; i++) {
      const m = ticks.mediaTime[i];
      const run = runs.at(-1);
      if (run && m >= run[0] - 1 && m <= run[1] + 1) run[1] = Math.max(run[1], m);
      else runs.push([m, m]);
    }
    const keep = (k) => runs.some(([a, b]) => k * FRAME_SEC >= a - KEEP_BEHIND_SEC && k * FRAME_SEC < b + KEEP_AHEAD_SEC);
    return [...analysed.keys()].filter(keep).sort((a, b) => a - b);
  }

  return {
    get seconds() { return seconds(); },
    get full() { return seconds() >= MAX_SEC; },

    // One frame heard live. d: { p, inferMs, rate, mediaTime, state, speed }
    frame(samples, d) {
      if (seconds() >= MAX_SEC) return;
      pcm.push(toInt16(samples));
      cols.p.push(round(d.p, 4));
      cols.inferMs.push(round(d.inferMs, 2));
      cols.rate.push(d.rate);
      cols.mediaTime.push(round(d.mediaTime, 3));
      cols.state.push(d.state ?? null);
      cols.speed.push(d.speed ?? null);
      n++;
    },

    // A frame the look-ahead analysis heard, starting at media time `at`;
    // samples: its 16 kHz audio, or null if it wasn't kept
    analysed(at, p, samples = null) {
      if (seconds() >= MAX_SEC) return;
      const k = Math.round(at / FRAME_SEC);
      const had = analysed.get(k);
      let audio = null;
      if (samples && (had?.audio || audioFrames < MAX_ANALYSED)) {
        audio = toInt16(samples);
        if (!had?.audio) audioFrames++;
      } else if (had?.audio) {
        audio = had.audio;
      }
      analysed.set(k, { p: round(p, 4), audio });
    },

    // One look-ahead tick while the video plays. d: { mediaTime, rate (asked
    // for), playing (the video's playbackRate), at (the schedule's answer:
    // 'talk', 'gameplay' or null), p }. status(): the analysis's status,
    // called about once a second
    tick(d, status) {
      if (seconds() >= MAX_SEC) return;
      const t = now() - t0;
      if (lastTick !== null) lookSec += Math.min(t - lastTick, MAX_TICK_SEC);
      lastTick = t;
      ticks.wall.push(round(t, 3));
      ticks.mediaTime.push(round(d.mediaTime, 3));
      ticks.rate.push(d.rate);
      ticks.playing.push(round(d.playing, 3));
      ticks.at.push(d.at ?? null);
      ticks.p.push(round(d.p, 4));
      if (status && t - lastStatus >= STATUS_SEC) {
        lastStatus = t;
        statuses.push({ wall: round(t, 3), ...status() });
      }
    },

    // Something that happened: 'reset' (what was heard so far was dropped;
    // reason: 'seek', 'new source' or 'look-ahead'), 'override', 'settings',
    // 'mode', 'drop'
    event(type, data = {}) {
      if (seconds() < MAX_SEC) events.push({ frame: n, wall: wall(), type, ...data });
    },

    toJSON() {
      const bytes = new Uint8Array(n * FRAME * 2);
      pcm.forEach((a, k) => bytes.set(new Uint8Array(a.buffer), k * FRAME * 2));
      let lookahead = null;
      if (ticks.wall.length || analysed.size) {
        const keys = playedFrames();
        const withAudio = keys.filter((k) => analysed.get(k).audio);
        const audioBytes = new Uint8Array(withAudio.length * FRAME * 2);
        withAudio.forEach((k, i) => audioBytes.set(new Uint8Array(analysed.get(k).audio.buffer), i * FRAME * 2));
        lookahead = {
          frameSec: FRAME_SEC,
          frames: {
            mediaTime: keys.map((k) => round(k * FRAME_SEC, 3)),
            p: keys.map((k) => analysed.get(k).p),
            audio: keys.map((k) => !!analysed.get(k).audio),
          },
          pcm: toBase64(audioBytes),
          ticks,
          status: statuses,
        };
      }
      return {
        format: FORMAT,
        version: 2,
        created,
        ...info,
        sampleRate: SAMPLE_RATE,
        frameSize: FRAME,
        frames: cols,
        events,
        pcm: toBase64(bytes),
        lookahead,
      };
    },
  };
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Int16 little-endian samples from a recording, as floats (for Node and the
// browser alike): the live audio, or with `lookahead` the analysed audio
// (the frames whose `audio` is true, in order)
export function decodePcm(rec, { lookahead = false } = {}) {
  const bin = atob(lookahead ? rec.lookahead?.pcm ?? '' : rec.pcm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  return Float32Array.from(i16, (x) => x / 32767);
}
