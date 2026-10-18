// Writes test/fixtures/traces.json from the probability traces Phase 0
// recorded in the browsers (spikes/phase0/results/traces-<browser>.json,
// not committed; see spikes/phase0/README.md to record them again).
//
// Each trace is Silero v6.2's speech probability for every 32 ms frame of
// one clip played at one speed, captured in Chrome or Firefox. Frame k ends
// at media time start + k * 0.032 * speed. The probabilities are stored as
// bytes (p * 255, rounded) in base64.
//
// Usage: node test/fixtures/make-traces.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const SPEEDS = [1, 2.5];
const out = [];
for (const browser of ['chrome', 'firefox']) {
  const traces = JSON.parse(readFileSync(new URL(`spikes/phase0/results/traces-${browser}.json`, root)));
  for (const t of traces) {
    if (t.model !== 'silero_vad_v6.2_16k' || !SPEEDS.includes(t.speed)) continue;
    const bytes = Uint8Array.from(t.probs, (p) => Math.round(p * 255));
    out.push({ browser, clip: t.clip, speed: t.speed, start: t.mediaEnd[0], probs: Buffer.from(bytes).toString('base64') });
  }
}
writeFileSync(new URL('test/fixtures/traces.json', root), JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${out.length} traces`);
