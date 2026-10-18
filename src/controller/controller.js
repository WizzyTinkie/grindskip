// The decision logic: turns Silero's speech probability for each 32 ms frame
// into a state and a playback speed. Pure: no browser APIs and no clocks.
// Time is counted in frames, which only arrive while the video plays, so
// pauses don't count towards any of the durations below.
//
// States:
//   speech    someone is talking: talk speed
//   wait      the speech has stopped, but not for long enough: still talk speed
//   gameplay  no one has talked for the wait: gameplay speed
//
// Speech starts when the probability stays at or above the start threshold
// for a few frames in a row, and stops when it falls below the lower end
// threshold. The start threshold rises with the playback speed, because
// sped-up game sound looks more like speech the faster it plays (PLAN.md,
// Phase 0 spike 2).

export const FRAME_SEC = 0.032;

export const PARAMS = Object.freeze({
  startLow: 0.5,             // start threshold at lowRate and slower
  startHigh: 0.9,            // start threshold at highRate and faster
  lowRate: 1,
  highRate: 2,
  end: 0.35,                 // end threshold
  minHysteresis: 0.05,       // the end threshold stays at least this far below the start
  minSpeechFrames: 2,        // frames in a row at gameplay speed before switching (64 ms)
  sensitivityStep: 0.05,     // start-threshold change per step of the sensitivity setting
  maxStart: 0.98,
  rewindMinGameplaySec: 3,   // rewind only after this long at gameplay speed...
  rewindAfterSeekSec: 5,     // ...and this long after a seek
  rewindMaxSec: 1.5,         // never further back than this
  rewindMarginSec: 0.5,      // extra media time before the detected onset
});

// Start threshold for audio playing at `rate`: interpolated linearly between
// startLow and startHigh, then lowered by `sensitivity` steps.
export function startThreshold(rate, sensitivity = 0, params = PARAMS) {
  const { startLow, startHigh, lowRate, highRate } = params;
  const f = Math.min(1, Math.max(0, (rate - lowRate) / (highRate - lowRate)));
  const t = startLow + f * (startHigh - startLow) - sensitivity * params.sensitivityStep;
  return Math.min(params.maxStart, Math.max(params.end + params.minHysteresis, t));
}

// settings: { talkSpeed, playSpeed, waitSec, sensitivity, rewind } (see
// shared/settings.js); params: PARAMS, or overrides for tuning.
export function createController(settings, params = PARAMS) {
  let s = settings;
  let state;
  let run;              // frames in a row at or above the start threshold, at gameplay speed
  let runStart;         // media time where that run started
  let waitFrames;       // frames in the wait state
  let gameplayFrames;   // frames in the gameplay state
  let sinceSeek = Infinity;

  const frames = (sec) => Math.round(sec / FRAME_SEC);
  const speedOf = (st) => (st === 'gameplay' ? s.playSpeed : s.talkSpeed);

  // A fresh start begins in the wait state, as if speech had just ended, so
  // the first words of a video or after a seek aren't rushed before the
  // model has heard anything.
  function reset({ seek = false } = {}) {
    state = 'wait';
    run = 0;
    runStart = null;
    waitFrames = 0;
    gameplayFrames = 0;
    if (seek) sinceSeek = 0;
  }
  reset();

  // Where to jump back to when speech has just been detected at gameplay
  // speed, or null when the safeguards say no.
  function rewindTarget(mediaTime) {
    if (!s.rewind || runStart === null || !Number.isFinite(mediaTime)) return null;
    if (gameplayFrames < frames(params.rewindMinGameplaySec)) return null;
    if (sinceSeek < frames(params.rewindAfterSeekSec)) return null;
    const target = Math.max(runStart - params.rewindMarginSec, mediaTime - params.rewindMaxSec, 0);
    return target < mediaTime ? target : null;
  }

  return {
    get state() { return state; },
    get speed() { return speedOf(state); },

    configure(next) { s = next; },
    reset,

    // One frame: p is the speech probability, rate the playback rate the
    // frame's audio was played at, mediaTime the video position at the
    // frame's end (only needed for rewind).
    frame({ p, rate, mediaTime }) {
      // While a speed change is taking effect the audio may still be at the
      // old rate, so the threshold is for the faster of the two
      const fast = Math.max(rate ?? 0, speedOf(state));
      const start = startThreshold(fast, s.sensitivity, params);
      const end = Math.min(params.end, start - params.minHysteresis);
      let rewindTo = null;
      if (sinceSeek < Infinity) sinceSeek++;

      if (state === 'gameplay') {
        gameplayFrames++;
        if (p >= start) {
          if (run++ === 0) runStart = Number.isFinite(mediaTime) ? mediaTime - FRAME_SEC * (rate ?? 1) : null;
        } else {
          run = 0;
        }
        if (run >= params.minSpeechFrames) {
          rewindTo = rewindTarget(mediaTime);
          state = 'speech';
        }
      } else if (state === 'speech') {
        if (p < end) {
          state = 'wait';
          waitFrames = 0;
        }
      } else if (p >= start) {
        state = 'speech';
      } else if (++waitFrames >= frames(s.waitSec)) {
        state = 'gameplay';
        gameplayFrames = 0;
        run = 0;
      }

      return { state, speed: speedOf(state), start, end, rewindTo };
    },
  };
}
