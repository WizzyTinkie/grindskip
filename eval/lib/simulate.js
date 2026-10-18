// Closed-loop replay of the controller on recordings of one clip at several
// fixed speeds, and the measures it is scored on. Pure (no Node or browser
// APIs), so the unit tests use it too.
//
// A source is one recording: for each frame, its speech probability and the
// media time at its end. The replay plays the clip from the start: each
// frame's probability comes from the recording at the speed the controller
// has chosen, at the current media position, and the position advances by
// one frame at that speed. A speed change reaches the audio lagFrames frames
// late, as in the browsers (Phase 0: 10-75 ms).
import { FRAME_SEC, createController } from '../../src/controller/controller.js';

// media: frame end times (ascending), p: probabilities, same length
export function source(media, p) {
  const at = (m) => {
    let lo = 0;
    let hi = media.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (media[mid] < m) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && m - media[lo - 1] < media[lo] - m) lo--;
    return p[lo];
  };
  return { media, p, at, start: media[0], end: media.at(-1) };
}

// sources: { [speed]: source }; settings.talkSpeed and settings.playSpeed
// must both have one. Returns per frame { media, speed, state, rewindTo }.
export function simulate(sources, settings, params, { lagFrames = 2 } = {}) {
  const srcs = [sources[settings.talkSpeed], sources[settings.playSpeed]];
  if (srcs.some((s) => !s)) throw new Error(`no recording at ${settings.talkSpeed}x or ${settings.playSpeed}x`);
  const start = Math.max(...srcs.map((s) => s.start));
  const end = Math.min(...srcs.map((s) => s.end));
  const c = createController(settings, params);
  const frames = [];
  let media = start;
  let playing = c.speed;     // the speed the audio is at
  let pending = null;        // { speed, in: frames until the audio switches }
  while (media <= end) {
    const r = c.frame({ p: sources[playing].at(media), rate: playing, mediaTime: media });
    frames.push({ media, speed: playing, state: r.state, rewindTo: r.rewindTo });
    media += FRAME_SEC * playing;
    if (r.rewindTo !== null) media = r.rewindTo;
    if (r.speed !== (pending?.speed ?? playing)) pending = { speed: r.speed, in: lagFrames };
    if (pending && pending.in-- <= 0) {
      playing = pending.speed;
      pending = null;
    }
  }
  return frames;
}

const BIN = 0.01;

// The Phase 3 measures for one replay against speech labels (intervals in
// media seconds, see labels.mjs):
//   speechAtTalkSpeed     share of the labelled speech heard at talk speed
//                         (with rewind, heard at talk speed at least once)
//   quietAtGameplaySpeed  share of the media without speech played at
//                         gameplay speed, leaving out the wait after speech
//   falseSlowdowns        switches to talk speed with no labelled speech
//                         from 1.5 s before to 1 s after, and the wall
//                         minutes of media without speech they happened in
//   delays                wall seconds from each labelled onset reached at
//                         gameplay speed to talk speed; missed: none in 3 s
export function score(frames, intervals, settings) {
  const end = Math.max(...frames.map((f) => f.media), 0);
  const bins = Math.ceil(end / BIN) + 1;
  const speech = new Uint8Array(bins);
  for (const [a, b] of intervals) speech.fill(1, Math.floor(a / BIN), Math.min(bins, Math.ceil(b / BIN)));
  const near = (m, before, after) => intervals.some(([a, b]) => b > m - before && a < m + after);
  const waitMedia = settings.waitSec * settings.talkSpeed + 0.2;
  const afterSpeech = (m) => intervals.some(([, b]) => m >= b && m < b + waitMedia);

  const slow = new Uint8Array(bins);
  let quiet = 0;
  let quietFast = 0;
  let quietWall = 0;
  let falseSlowdowns = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const dm = FRAME_SEC * f.speed;
    if (f.speed === settings.talkSpeed) slow.fill(1, Math.max(0, Math.floor((f.media - dm) / BIN)), Math.ceil(f.media / BIN));
    const m = f.media;
    if (!speech[Math.floor(m / BIN)] && !afterSpeech(m)) {
      quiet += dm;
      quietWall += FRAME_SEC;
      if (f.speed === settings.playSpeed) quietFast += dm;
    }
    if (i > 0 && frames[i - 1].state === 'gameplay' && f.state === 'speech' && !near(m, 1.5, 1)) falseSlowdowns++;
  }
  let speechBins = 0;
  let speechSlow = 0;
  const lo = Math.floor(frames[0].media / BIN);
  for (let k = lo; k < bins; k++) {
    if (!speech[k]) continue;
    speechBins++;
    if (slow[k]) speechSlow++;
  }

  // Onsets: speech after at least 1 s without
  const delays = [];
  let missed = 0;
  for (let j = 0; j < intervals.length; j++) {
    const onset = intervals[j][0];
    if (j > 0 && onset - intervals[j - 1][1] < 1) continue;
    const i = frames.findIndex((f) => f.media >= onset);
    if (i <= 0 || frames[i - 1].state !== 'gameplay') continue;
    const k = frames.findIndex((f, x) => x >= i && f.state === 'speech');
    if (k < 0 || (k - i) * FRAME_SEC > 3) missed++;
    else delays.push((k - i) * FRAME_SEC);
  }

  return {
    speechAtTalkSpeed: speechBins ? speechSlow / speechBins : NaN,
    speechSec: speechBins * BIN,
    quietAtGameplaySpeed: quiet ? quietFast / quiet : NaN,
    quietSec: quiet,
    falseSlowdowns,
    quietMin: quietWall / 60,
    delays,
    missed,
    wallMin: frames.length * FRAME_SEC / 60,
  };
}

// Sums the scores of several replays: media-weighted shares, counts added.
export function combine(scores) {
  const sum = (k) => scores.reduce((a, s) => a + s[k], 0);
  const delays = scores.flatMap((s) => s.delays).sort((a, b) => a - b);
  const q = (f) => (delays.length ? delays[Math.min(delays.length - 1, Math.floor(f * delays.length))] : NaN);
  const weighted = (k, w) => scores.reduce((a, s) => a + (Number.isFinite(s[k]) ? s[k] * s[w] : 0), 0)
    / scores.reduce((a, s) => a + (Number.isFinite(s[k]) ? s[w] : 0), 0);
  return {
    speechAtTalkSpeed: weighted('speechAtTalkSpeed', 'speechSec'),
    quietAtGameplaySpeed: weighted('quietAtGameplaySpeed', 'quietSec'),
    falseSlowdownsPerMin: sum('falseSlowdowns') / sum('quietMin'),
    falseSlowdowns: sum('falseSlowdowns'),
    quietMin: sum('quietMin'),
    medianDelay: q(0.5),
    p90Delay: q(0.9),
    onsets: delays.length + sum('missed'),
    missed: sum('missed'),
  };
}
