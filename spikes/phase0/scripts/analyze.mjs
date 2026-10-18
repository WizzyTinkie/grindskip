// Spike 2, scoring: compares Silero traces at each speed with the same
// clip's 1x ffmpeg trace and with the caption word timings.
//
// A trace is { source, model, clip, speed, mediaEnd[], probs[] }, one entry
// per 32 ms frame, with the media time at the end of the frame. Traces from
// ffmpeg (speed-offline.mjs) and from browser capture use the same format.
//
// Usage: node scripts/analyze.mjs results/traces-ffmpeg.json [more.json ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadWords, speechIntervals } from '../lib/captions.mjs';
import { CLIPS } from '../lib/clips.mjs';
import { auc, rateAbove, median, inIntervals } from '../lib/metrics.mjs';

const FRAME_SEC = 0.032;
const THRESHOLDS = [0.8, 0.65, 0.5, 0.35, 0.25];
const QUIET = 0.15;       // 1x probability below which media counts as quiet
const QUIET_MARGIN = 1.0; // media seconds of quiet needed on both sides
const MIN_RUN = 2;        // frames above the threshold that make a trigger

const files = process.argv.slice(2);
if (!files.length) files.push('results/traces-ffmpeg.json');
const traces = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')));
const ref = new Map(traces.filter((t) => t.source === 'ffmpeg' && t.speed === 1)
  .map((t) => [`${t.model}|${t.clip}`, t.probs]));
const speech = new Map(CLIPS.map((c) => [c.name, speechIntervals(loadWords(c.subs))
  .map(([s, e]) => [s - c.offset, e - c.offset])]));

// Statistics of the 1x trace over the media span [a, b)
function span(p1x, a, b) {
  const i0 = Math.max(0, Math.floor(a / FRAME_SEC));
  const i1 = Math.min(p1x.length, Math.max(i0 + 1, Math.ceil(b / FRAME_SEC)));
  let sum = 0;
  let max = 0;
  for (let i = i0; i < i1; i++) { sum += p1x[i]; max = Math.max(max, p1x[i]); }
  return { mean: sum / Math.max(1, i1 - i0), max };
}

// Speech onsets in the 1x trace: rises above 0.5 after >= 1 s below 0.35
function onsets(p1x) {
  const out = [];
  let quiet = 0;
  for (let i = 0; i < p1x.length; i++) {
    if (p1x[i] > 0.5 && quiet >= 1 / FRAME_SEC) out.push(i * FRAME_SEC);
    quiet = p1x[i] < 0.35 ? quiet + 1 : 0;
  }
  return out;
}

function score(t) {
  const p1x = ref.get(`${t.model}|${t.clip}`);
  if (!p1x) return null;
  const n = t.probs.length;
  const start = t.mediaEnd.map((e, k) => (k ? t.mediaEnd[k - 1] : e - FRAME_SEC * t.speed));
  const refMean = [];
  const farQuiet = [];
  const cap = [];
  for (let k = 0; k < n; k++) {
    refMean.push(span(p1x, start[k], t.mediaEnd[k]).mean);
    farQuiet.push(span(p1x, start[k] - QUIET_MARGIN, t.mediaEnd[k] + QUIET_MARGIN).max < QUIET);
    cap.push(inIntervals((start[k] + t.mediaEnd[k]) / 2, speech.get(t.clip)));
  }
  const quietWallMin = farQuiet.filter(Boolean).length * FRAME_SEC / 60;
  const row = {
    source: t.source, model: t.model, clip: t.clip, speed: t.speed, frames: n,
    aucCaptions: auc(t.probs, cap),
    quietWallMin,
    byThreshold: {},
  };
  for (const th of THRESHOLDS) {
    // False triggers: runs of MIN_RUN frames above the threshold that start
    // in long quiet stretches of the 1x trace
    let triggers = 0;
    for (let k = 0, run = 0; k < n; k++) {
      run = t.probs[k] > th ? run + 1 : 0;
      if (run === MIN_RUN && farQuiet[k - MIN_RUN + 1]) triggers++;
    }
    // Onset latency in media seconds, from the 1x onset to the end of the
    // first frame above the threshold
    const lat = [];
    let missed = 0;
    for (const t0 of onsets(p1x)) {
      let found = null;
      for (let k = 0; k < n; k++) {
        if (t.mediaEnd[k] < t0 - 0.2) continue;
        if (t.mediaEnd[k] > t0 + 1.5) break;
        if (t.probs[k] > th) { found = t.mediaEnd[k] - t0; break; }
      }
      if (found === null) missed++; else lat.push(found);
    }
    row.byThreshold[th] = {
      recallVs1x: rateAbove(t.probs, refMean.map((r) => r > 0.6), th),
      falseQuiet: rateAbove(t.probs, farQuiet, th),
      falseTriggers: triggers,
      recallCaptions: rateAbove(t.probs, cap, th),
      falseCaptions: rateAbove(t.probs, cap.map((x) => !x), th),
      onsetLatencies: lat,
      onsetMissed: missed,
    };
  }
  return row;
}

const rows = traces.map(score).filter(Boolean);

// Pools the clips of one source/model/speed
function pool(group) {
  const out = { quietWallMin: 0, frames: 0, byThreshold: {} };
  for (const r of group) { out.quietWallMin += r.quietWallMin; out.frames += r.frames; }
  out.aucCaptions = group.reduce((s, r) => s + r.aucCaptions, 0) / group.length;
  for (const th of THRESHOLDS) {
    const bs = group.map((r) => r.byThreshold[th]);
    const w = group.map((r) => r.frames);
    const wsum = w.reduce((a, b) => a + b, 0);
    const avg = (key) => bs.reduce((s, b, i) => s + b[key] * w[i], 0) / wsum;
    const lat = bs.flatMap((b) => b.onsetLatencies);
    const missed = bs.reduce((s, b) => s + b.onsetMissed, 0);
    out.byThreshold[th] = {
      recallVs1x: avg('recallVs1x'),
      falseQuiet: avg('falseQuiet'),
      falseTriggersPerMin: bs.reduce((s, b) => s + b.falseTriggers, 0) / out.quietWallMin,
      recallCaptions: avg('recallCaptions'),
      falseCaptions: avg('falseCaptions'),
      onsets: lat.length + missed,
      onsetMissed: missed,
      onsetMedianMs: median(lat) * 1000,
    };
  }
  return out;
}

const groups = new Map();
for (const r of rows) {
  const key = `${r.source}|${r.model}|${r.speed}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const pct = (x) => (x * 100).toFixed(1);
const lines = [];
let lastModel = '';
for (const [key, group] of groups) {
  const [source, model, speed] = key.split('|');
  const p = pool(group);
  if (`${source}|${model}` !== lastModel) {
    lastModel = `${source}|${model}`;
    lines.push('', `### ${model} (${source})`, '',
      '| speed | AUC vs captions | threshold | speech kept vs 1x | onsets found | median onset delay (media) | quiet frames above | false triggers / quiet min |',
      '|---|---|---|---|---|---|---|---|');
  }
  for (const th of THRESHOLDS) {
    const b = p.byThreshold[th];
    lines.push(`| ${speed}x | ${p.aucCaptions.toFixed(3)} | ${th} | ${pct(b.recallVs1x)}% | ${b.onsets - b.onsetMissed}/${b.onsets} | ${b.onsetMedianMs.toFixed(0)} ms | ${pct(b.falseQuiet)}% | ${b.falseTriggersPerMin.toFixed(2)} |`);
  }
}
const quietMin = [...groups.values()][0].reduce((s, r) => s + r.quietWallMin * r.speed, 0);
const md = `Pooled over ${CLIPS.length} clips; ${quietMin.toFixed(1)} min of long-quiet media `
  + `(1x probability < ${QUIET} for ${QUIET_MARGIN} s either side). A false trigger is ${MIN_RUN} frames `
  + 'in a row above the threshold starting in long-quiet media.\n' + lines.join('\n') + '\n';
const out = files.length === 1 ? files[0].replace(/traces-(.*)\.json$/, 'scores-$1') : 'results/scores-combined';
writeFileSync(`${out}.md`, md);
writeFileSync(`${out}.json`, JSON.stringify(rows, null, 1));
console.log(md);
console.log(`wrote ${out}.md and ${out}.json`);
