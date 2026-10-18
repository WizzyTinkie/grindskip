// Debug recording: keeps the 16 kHz audio the detector heard, its
// probabilities and the controller's decisions, frame by frame, so that a
// session can be replayed offline (eval/replay.mjs) with other thresholds or
// another model. Started and saved by the user; nothing leaves the computer
// unless they share the file.

export const FORMAT = 'grindskip-recording';
export const MAX_SEC = 600;
const FRAME = 512;
const SAMPLE_RATE = 16000;
const MAX_FRAMES = Math.round(MAX_SEC * SAMPLE_RATE / FRAME);

const round = (x, d) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

// info: anything worth keeping about where and how it was recorded
export function createRecorder(info = {}) {
  const created = new Date().toISOString();
  const pcm = [];
  const cols = { p: [], inferMs: [], rate: [], mediaTime: [], state: [], speed: [] };
  const events = [];
  let n = 0;

  return {
    get seconds() { return n * FRAME / SAMPLE_RATE; },
    get full() { return n >= MAX_FRAMES; },

    // One analysed frame. d: { p, inferMs, rate, mediaTime, state, speed }
    frame(samples, d) {
      if (n >= MAX_FRAMES) return;
      const i16 = new Int16Array(FRAME);
      for (let i = 0; i < FRAME; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
      pcm.push(i16);
      cols.p.push(round(d.p, 4));
      cols.inferMs.push(round(d.inferMs, 2));
      cols.rate.push(d.rate);
      cols.mediaTime.push(round(d.mediaTime, 3));
      cols.state.push(d.state ?? null);
      cols.speed.push(d.speed ?? null);
      n++;
    },

    // Something that happened before frame n: 'reset' (the detector's
    // state was cleared), 'seek', 'source', 'override', 'settings'
    event(type, data = {}) {
      if (n < MAX_FRAMES) events.push({ frame: n, type, ...data });
    },

    toJSON() {
      const bytes = new Uint8Array(n * FRAME * 2);
      pcm.forEach((a, k) => bytes.set(new Uint8Array(a.buffer), k * FRAME * 2));
      return {
        format: FORMAT,
        version: 1,
        created,
        ...info,
        sampleRate: SAMPLE_RATE,
        frameSize: FRAME,
        frames: cols,
        events,
        pcm: toBase64(bytes),
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
// browser alike).
export function decodePcm(rec) {
  const bin = atob(rec.pcm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  return Float32Array.from(i16, (x) => x / 32767);
}
