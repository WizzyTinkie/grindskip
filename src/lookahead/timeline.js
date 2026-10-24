// Speech probabilities by media time, one per 32 ms frame, as the look-ahead
// analysis produces them (lookahead/analysis.js). Frames are filed under the
// nearest multiple of 32 ms, so a stretch analysed again after a seek, from
// a slightly different start, replaces what was there.
import { FRAME_SEC } from '../controller/controller.js';

export function createTimeline() {
  const p = new Map();    // frame index -> probability
  const index = (t) => Math.round(t / FRAME_SEC);

  return {
    get size() { return p.size; },
    // The probability of the frame that starts at `start`
    set(start, prob) {
      p.set(index(start), prob);
    },
    // The probability of the frame playing at media time t, or undefined
    at(t) {
      return p.get(Math.floor(t / FRAME_SEC));
    },
    // By frame index (media time / 32 ms, rounded down)
    has(k) { return p.has(k); },
    get(k) { return p.get(k); },
    // The frames from media time t to t + sec, oldest first, or null if
    // any of them hasn't been analysed
    span(t, sec) {
      const out = [];
      const last = Math.floor((t + sec) / FRAME_SEC);
      for (let k = Math.floor(t / FRAME_SEC); k <= last; k++) {
        if (!p.has(k)) return null;
        out.push(p.get(k));
      }
      return out;
    },
    // How far beyond media time t the analysis reaches without a hole, in
    // seconds (0 if the frame at t isn't analysed)
    ahead(t) {
      let k = Math.floor(t / FRAME_SEC);
      const first = k;
      while (p.has(k)) k++;
      return Math.max(0, (k - first) * FRAME_SEC - (t - first * FRAME_SEC));
    },
    // The frames from media time t on, as [start, probability], in no order
    *from(t) {
      const k0 = Math.floor(t / FRAME_SEC);
      for (const [k, prob] of p) if (k >= k0) yield [k * FRAME_SEC, prob];
    },
    // Forgets the frames before media time t
    prune(t) {
      const k0 = Math.floor(t / FRAME_SEC);
      for (const k of p.keys()) if (k < k0) p.delete(k);
    },
    clear() { p.clear(); },
  };
}
