// The Phase 0 probability traces in test/fixtures/traces.json (see
// make-traces.mjs), and a closed-loop replay of the controller on them.
import { readFileSync } from 'node:fs';
import { FRAME_SEC, createController } from '../src/controller/controller.js';

const raw = JSON.parse(readFileSync(new URL('fixtures/traces.json', import.meta.url)));

export const CLIPS = ['bumpy', 'mattg', 'nocomm'];
export const BROWSERS = ['chrome', 'firefox'];

export function trace(browser, clip, speed) {
  const t = raw.find((x) => x.browser === browser && x.clip === clip && x.speed === speed);
  if (!t) throw new Error(`no trace for ${browser} ${clip} ${speed}x`);
  const probs = Float32Array.from(Buffer.from(t.probs, 'base64'), (b) => b / 255);
  const step = FRAME_SEC * speed;
  // Probability of the frame ending nearest media time m
  const at = (m) => probs[Math.min(probs.length - 1, Math.max(0, Math.round((m - t.start) / step)))];
  return { ...t, probs, step, end: t.start + (probs.length - 1) * step, at };
}

// Plays a clip through the controller: each frame's probability comes from
// the trace recorded at the speed the controller has chosen, at the current
// media position, and the position advances by one frame at that speed.
// Talk speed must be 1x and gameplay speed one of the recorded ones.
//
// Returns per frame { media, speed, state } plus the clip's labels from the
// 1x trace, as Phase 0 scored them: speech where p > 0.6, long quiet where
// p < 0.15 for a second either side.
export function replay(browser, clip, settings, params) {
  const traces = { 1: trace(browser, clip, 1), [settings.playSpeed]: trace(browser, clip, settings.playSpeed) };
  const ref = traces[1];
  const c = createController(settings, params);
  const frames = [];
  let media = Math.max(...Object.values(traces).map((t) => t.start));
  const end = Math.min(...Object.values(traces).map((t) => t.end));
  while (media <= end) {
    const speed = c.speed;
    const t = traces[speed];
    const r = c.frame({ p: t.at(media), rate: speed, mediaTime: media });
    frames.push({ media, speed, state: r.state, rewindTo: r.rewindTo });
    media += t.step;
  }
  const speech = (m) => ref.at(m) > 0.6;
  const longQuiet = (m) => {
    for (let x = m - 1; x <= m + 1; x += ref.step) if (ref.at(x) >= 0.15) return false;
    return true;
  };
  return { frames, speech, longQuiet };
}

// The measures Phase 3 will tune on, over one replay
export function score({ frames, speech, longQuiet }) {
  let speechMedia = 0;
  let speechSlow = 0;
  let quietMedia = 0;
  let quietFast = 0;
  let falseSlowdowns = 0;
  let quietWall = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const dm = FRAME_SEC * f.speed;
    if (speech(f.media)) {
      speechMedia += dm;
      if (f.speed === 1) speechSlow += dm;
    }
    if (longQuiet(f.media)) {
      quietMedia += dm;
      quietWall += FRAME_SEC;
      if (f.speed > 1) quietFast += dm;
      if (i > 0 && frames[i - 1].state === 'gameplay' && f.state === 'speech') falseSlowdowns++;
    }
  }
  return {
    speechAtTalkSpeed: speechSlow / speechMedia,
    quietAtGameplaySpeed: quietFast / quietMedia,
    falseSlowdownsPerMin: falseSlowdowns / (quietWall / 60),
    quietMin: quietWall / 60,
  };
}
