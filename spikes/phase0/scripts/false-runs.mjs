// False triggers in long-quiet media by minimum run length: how much a
// minimum speech duration would remove. Uses the same quiet definition as
// analyze.mjs (1x ffmpeg probability < 0.15 for 1 s either side).
//
// Usage: node scripts/false-runs.mjs results/traces-chrome.json [...]
import { readFileSync } from 'node:fs';

const FRAME_SEC = 0.032;
const files = process.argv.slice(2);
const all = [JSON.parse(readFileSync('results/traces-ffmpeg.json', 'utf8')), ...files.map((f) => JSON.parse(readFileSync(f, 'utf8')))].flat();
const ref = new Map(all.filter((t) => t.source === 'ffmpeg' && t.speed === 1).map((t) => [`${t.model}|${t.clip}`, t.probs]));
const quietAround = (p1x, a, b) => {
  const i0 = Math.max(0, Math.floor((a - 1) / FRAME_SEC)), i1 = Math.min(p1x.length, Math.ceil((b + 1) / FRAME_SEC));
  for (let i = i0; i < i1; i++) if (p1x[i] >= 0.15) return false;
  return true;
};
const MINS = [1, 2, 3, 4, 6, 8];
const groups = new Map();
for (const t of all) {
  if (t.model !== 'silero_vad_v6.2_16k' || t.speed === 1) continue;
  const key = `${t.source}|${t.speed}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(t);
}
for (const th of [0.5, 0.65, 0.8]) {
  console.log(`\nthreshold ${th}: false triggers per quiet minute (wall) by minimum run of frames above it`);
  console.log('source         speed  ' + MINS.map((m) => `>=${m}`.padStart(6)).join(''));
  for (const [key, ts] of groups) {
    const [source, speed] = key.split('|');
    let quietMin = 0;
    const counts = MINS.map(() => 0);
    for (const t of ts) {
      const p1x = ref.get(`${t.model}|${t.clip}`);
      const quiet = t.probs.map((_, k) => quietAround(p1x, k ? t.mediaEnd[k - 1] : t.mediaEnd[k] - FRAME_SEC * t.speed, t.mediaEnd[k]));
      quietMin += quiet.filter(Boolean).length * FRAME_SEC / 60;
      for (let k = 0; k < t.probs.length;) {
        if (t.probs[k] > th && quiet[k]) {
          let e = k;
          while (e < t.probs.length && t.probs[e] > th) e++;
          MINS.forEach((m, i) => { if (e - k >= m) counts[i]++; });
          k = e;
        } else k++;
      }
    }
    console.log(`${source.padEnd(14)} ${speed.padEnd(6)} ` + counts.map((c) => (c / quietMin).toFixed(1).padStart(6)).join(''));
  }
}
