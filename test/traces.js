// The Phase 0 probability traces in test/fixtures/traces.json (see
// make-traces.mjs), replayed through the controller with the evaluation's
// closed-loop replay (eval/lib/simulate.js).
import { readFileSync } from 'node:fs';
import { FRAME_SEC } from '../src/controller/controller.js';
import { simulate, source } from '../eval/lib/simulate.js';

const raw = JSON.parse(readFileSync(new URL('fixtures/traces.json', import.meta.url)));

export const CLIPS = ['bumpy', 'mattg', 'nocomm'];
export const BROWSERS = ['chrome', 'firefox'];

export function trace(browser, clip, speed) {
  const t = raw.find((x) => x.browser === browser && x.clip === clip && x.speed === speed);
  if (!t) throw new Error(`no trace for ${browser} ${clip} ${speed}x`);
  const p = Float32Array.from(Buffer.from(t.probs, 'base64'), (b) => b / 255);
  const media = Float64Array.from(p, (_, k) => t.start + k * FRAME_SEC * speed);
  return source(media, p);
}

// Talk speed must be 1x and gameplay speed one of the recorded ones.
// Returns the replay's frames and the labels Phase 0 scored against: speech
// where the 1x trace is above 0.6.
export function replay(browser, clip, settings, params) {
  const ref = trace(browser, clip, 1);
  const sources = { 1: ref, [settings.playSpeed]: trace(browser, clip, settings.playSpeed) };
  const frames = simulate(sources, settings, params);
  const intervals = [];
  for (let k = 0; k < ref.p.length; k++) {
    if (ref.p[k] <= 0.6) continue;
    const a = ref.media[k] - FRAME_SEC;
    const last = intervals.at(-1);
    if (last && a - last[1] < 0.05) last[1] = ref.media[k];
    else intervals.push([a, ref.media[k]]);
  }
  return { frames, intervals };
}
