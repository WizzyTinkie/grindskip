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
  minSpeechFrames: 1,        // frames in a row at gameplay speed before switching, below fastRate (32 ms)...
  minSpeechFramesFast: 2,    // ...and from fastRate up (64 ms), where game sound passes for speech more often
  fastRate: 3,
  sensitivityStep: 0.05,     // start-threshold change per step of the sensitivity setting
  maxStart: 0.98,
});

// Start threshold for audio playing at `rate`: interpolated linearly between
// startLow and startHigh, then lowered by `sensitivity` steps.
export function startThreshold(rate, sensitivity = 0, params = PARAMS) {
  const { startLow, startHigh, lowRate, highRate } = params;
  const f = Math.min(1, Math.max(0, (rate - lowRate) / (highRate - lowRate)));
  const t = startLow + f * (startHigh - startLow) - sensitivity * params.sensitivityStep;
  return Math.min(params.maxStart, Math.max(params.end + params.minHysteresis, t));
}

// Frames in a row at or above the start threshold that count as speech, for
// audio playing at `rate`. One frame switches 32 ms sooner, but from 3x up
// it lets through game sound (Phase 3 replay: 6 false slowdowns instead of
// 2 at 4x, 1 instead of 0 at 3x).
export function minSpeechFrames(rate, params = PARAMS) {
  return rate >= params.fastRate ? params.minSpeechFramesFast : params.minSpeechFrames;
}

// settings: { talkSpeed, playSpeed, waitSec, sensitivity } (see
// shared/settings.js); params: PARAMS, or overrides for tuning.
export function createController(settings, params = PARAMS) {
  let s = settings;
  let state;
  let run;              // frames in a row at or above the start threshold, at gameplay speed
  let waitFrames;       // frames in the wait state

  const frames = (sec) => Math.round(sec / FRAME_SEC);
  const speedOf = (st) => (st === 'gameplay' ? s.playSpeed : s.talkSpeed);

  // A fresh start begins in the wait state, as if speech had just ended, so
  // the first words of a video or after a seek aren't rushed before the
  // model has heard anything.
  function reset() {
    state = 'wait';
    run = 0;
    waitFrames = 0;
  }
  reset();

  return {
    get state() { return state; },
    get speed() { return speedOf(state); },

    configure(next) { s = next; },
    reset,

    // One frame: p is the speech probability, rate the playback rate the
    // frame's audio was played at.
    frame({ p, rate }) {
      // While a speed change is taking effect the audio may still be at the
      // old rate, so the threshold is for the faster of the two
      const fast = Math.max(rate ?? 0, speedOf(state));
      const start = startThreshold(fast, s.sensitivity, params);
      const end = Math.min(params.end, start - params.minHysteresis);

      if (state === 'gameplay') {
        run = p >= start ? run + 1 : 0;
        if (run >= minSpeechFrames(fast, params)) state = 'speech';
      } else if (state === 'speech') {
        if (p < end) {
          state = 'wait';
          waitFrames = 0;
        }
      } else if (p >= start) {
        state = 'speech';
      } else if (++waitFrames >= frames(s.waitSec)) {
        state = 'gameplay';
        run = 0;
      }

      return { state, speed: speedOf(state), start, end };
    },
  };
}
