// Decides the speed from the look-ahead timeline (timeline.js): which
// stretches of the media to play at talk speed, known before they play.
// Pure: no browser APIs and no clocks.
//
// The rules are the controller's (controller/controller.js), applied to the
// analysis of the audio at normal speed: speech starts at a run of frames at
// or above the talk-speed start threshold and goes on until the probability
// falls below the end threshold; the wait after it stays at talk speed.
// Knowing the audio in advance changes two things (spikes/lookahead):
// - the run must last MIN_FRAMES (0.26 s), which filters out short sounds
//   that aren't speech, but talk speed starts at the run's first frame, so
//   the longer minimum costs no delay;
// - playback slows down a lead (wall time) before that, so that the speed
//   change, which takes a while to take effect, lands before the speech:
//   leadSec, or more where the change is measured to take longer
//   (lag.js).
import { FRAME_SEC, PARAMS, startThreshold } from '../controller/controller.js';

export const LOOKAHEAD = Object.freeze({
  minFrames: 8,
  leadSec: 0.12,
});

// timeline: { has(k), get(k) } by 32 ms frame index; settings: the
// Grindskip settings (talkSpeed, playSpeed, waitSec, sensitivity)
export function createSchedule(timeline, settings, params = PARAMS, look = LOOKAHEAD) {
  let s = settings;
  let origin = null;      // where the schedule started, in media seconds
  let k = null;           // the next frame to read
  let state;              // 'speech', 'wait' or 'gameplay' at frame k
  let run;                // frames in a row at or above the start threshold, at gameplay
  let waited;             // frames in the wait state
  let from;               // where the current talk stretch started
  let talk;               // finished talk stretches [start, end) in media seconds

  // A fresh start at media time t in the wait state, as the controller
  // starts after a seek: the first words aren't rushed
  function reset(t) {
    k = Math.floor(t / FRAME_SEC);
    origin = k * FRAME_SEC;
    state = 'wait';
    run = 0;
    waited = 0;
    from = k * FRAME_SEC;
    talk = [];
  }

  function step(p) {
    // The analysed audio is at normal speed
    const start = startThreshold(1, s.sensitivity, params);
    const end = Math.min(params.end, start - params.minHysteresis);
    if (state === 'gameplay') {
      run = p >= start ? run + 1 : 0;
      if (run >= look.minFrames) {
        state = 'speech';
        from = (k - run + 1) * FRAME_SEC;
      }
    } else if (state === 'speech') {
      if (p < end) {
        state = 'wait';
        waited = 0;
      }
    } else if (p >= start) {
      state = 'speech';
    } else if (++waited * FRAME_SEC >= s.waitSec * s.talkSpeed) {
      state = 'gameplay';
      run = 0;
      talk.push([from, k * FRAME_SEC]);
      if (talk.length > 64) talk.shift();
    }
  }

  return {
    reset,
    configure(next) { s = next; },
    // What to play at media time t: 'talk', 'gameplay', or null when the
    // analysis doesn't reach far enough beyond t to know. leadSec: how far
    // ahead of speech to slow down, in wall time
    at(t, leadSec = look.leadSec) {
      if (k === null || t < origin || t >= k * FRAME_SEC + 1) {
        // Not started, or t is outside what the schedule has covered (a
        // seek it wasn't told about)
        if (!timeline.has(Math.floor(t / FRAME_SEC))) return null;
        reset(t);
      }
      while (timeline.has(k)) {
        step(timeline.get(k));
        k++;
      }
      const lead = leadSec * s.playSpeed;
      // The run that would start speech must be known too
      if (k * FRAME_SEC < t + lead + look.minFrames * FRAME_SEC) return null;
      if (state !== 'gameplay' && from <= t + lead) return 'talk';
      return talk.some(([a, b]) => a <= t + lead && t < b) ? 'talk' : 'gameplay';
    },
  };
}
