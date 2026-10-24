// Captures a video's audio and cuts it into 32 ms frames at 16 kHz:
//
//   captureStream() -> AnalyserNode, polled every 30 ms for the samples
//   rendered since the previous poll -> resampler -> 512-sample frames
//
// An AudioWorklet would be the obvious tool, but YouTube's CSP blocked one
// loaded from a blob URL in the original project; the analyser works there.
// mozCaptureStream() is never used: it mutes the video.
import { createFramer, createResampler } from '../vad/resample.js';
import { FRAME, SAMPLE_RATE } from '../vad/silero.js';
import { isPlaying } from './video.js';

const POLL_MS = 30;
const ANALYSER_SIZE = 32768;  // 0.7 s at 48 kHz: room for a late timer
// After a speed change the captured audio keeps the old rate for a moment.
// The change counts as done once the video clock has run at the new rate
// for this many polls in a row, or after SETTLE_MAX_MS.
const SETTLE_POLLS = 2;
const SETTLE_MAX_MS = 1000;

// onFrame(frame, { rate, mediaTime }) gets each frame (its own copy) with
// the playback rate its audio was played at (while a speed change settles,
// the faster of the old and the new) and the video position at its end.
export function startCapture(video, onFrame) {
  const ctx = new AudioContext();
  const stream = video.captureStream();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = ANALYSER_SIZE;
  analyser.smoothingTimeConstant = 0;
  const buf = new Float32Array(ANALYSER_SIZE);
  const resampler = createResampler(ctx.sampleRate, SAMPLE_RATE);
  const framer = createFramer(FRAME);

  // The source follows the newest audio track: the stream gets new tracks
  // when the video's source changes (a new video in YouTube's player)
  let track = null;
  let source = null;
  const connectTrack = () => {
    const live = stream.getAudioTracks().filter((t) => t.readyState === 'live');
    const next = live.at(-1) ?? null;
    if (next === track) return;
    source?.disconnect();
    track = next;
    source = track ? ctx.createMediaStreamSource(new MediaStream([track])) : null;
    source?.connect(analyser);
  };
  stream.addEventListener('addtrack', connectTrack);
  stream.addEventListener('removetrack', connectTrack);
  connectTrack();

  // The context may start suspended when the page hasn't had a click or key
  // press yet; it then resumes on the first one. Until then its clock stands
  // still and no frames come.
  const resume = () => {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  resume();
  const gestures = ['pointerdown', 'keydown'];
  for (const g of gestures) window.addEventListener(g, resume, true);

  let lastCtxTime = ctx.currentTime;
  let lastMediaTime = video.currentTime;
  let rate = video.playbackRate;
  let settleFrom = rate;
  let settleCount = 0;
  let settleUntil = 0;

  const poll = () => {
    const ctxTime = ctx.currentTime;
    const dt = ctxTime - lastCtxTime;
    lastCtxTime = ctxTime;
    const mediaTime = video.currentTime;
    const mediaDt = mediaTime - lastMediaTime;
    lastMediaTime = mediaTime;
    const now = performance.now();

    if (video.playbackRate !== rate) {
      settleFrom = rate;
      rate = video.playbackRate;
      settleCount = 0;
      settleUntil = now + SETTLE_MAX_MS;
    } else if (now < settleUntil && dt > 0) {
      const clockRate = mediaDt / dt;
      const atNew = Math.abs(clockRate - rate) < Math.abs(clockRate - settleFrom);
      settleCount = atNew ? settleCount + 1 : 0;
      if (settleCount >= SETTLE_POLLS) settleUntil = 0;
    }
    if (!isPlaying(video) || dt <= 0) return;

    const n = Math.min(Math.round(dt * ctx.sampleRate), ANALYSER_SIZE);
    analyser.getFloatTimeDomainData(buf);
    const meta = { rate: now < settleUntil ? Math.max(rate, settleFrom) : rate, mediaTime };
    framer.push(resampler.push(buf.subarray(ANALYSER_SIZE - n)), (frame) => onFrame(frame.slice(), meta));
  };
  const timer = setInterval(poll, POLL_MS);

  return {
    get suspended() { return ctx.state === 'suspended'; },
    // Drops the audio in the resampler and framer, e.g. after a seek.
    reset() {
      resampler.reset();
      framer.reset();
    },
    stop() {
      clearInterval(timer);
      for (const g of gestures) window.removeEventListener(g, resume, true);
      stream.removeEventListener('addtrack', connectTrack);
      stream.removeEventListener('removetrack', connectTrack);
      source?.disconnect();
      for (const t of stream.getTracks()) t.stop();
      ctx.close().catch(() => {});
    },
  };
}
