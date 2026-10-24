// Replays a debug recording made in look-ahead mode (the popup's "Start a
// debug recording"; src/content/recorder.js): what the analysis reached and
// how long speed changes took, then the schedule run again over the
// recorded ticks, with the recorded settings or others, against what it
// decided in the browser.
//
// Usage: node eval/lookahead.mjs recording.json [options]
//   --set key=value   override a setting (playSpeed, talkSpeed, waitSec,
//                     sensitivity) or a look-ahead parameter (minFrames,
//                     leadSec); comma-separate several
//   --lead 0.2        the lead in wall seconds (default: what the browser
//                     used at each tick, from the status)
//   --probs node      Silero rerun under Node on the recorded audio, where
//                     the frames have it (default: the browser's
//                     probabilities)
//   --model path      with --probs node: another model
//   --stretches       list every talk stretch
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { FRAME_SEC, PARAMS } from '../src/controller/controller.js';
import { KEEP_BEHIND_SEC, decodePcm } from '../src/content/recorder.js';
import { LOOKAHEAD, createSchedule } from '../src/lookahead/schedule.js';
import { createTimeline } from '../src/lookahead/timeline.js';
import { DEFAULTS } from '../src/shared/settings.js';
import { createModel } from '../src/vad/silero.js';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const file = args.find((a) => a.endsWith('.json'));
if (!file) {
  console.error('Usage: node eval/lookahead.mjs recording.json [--set key=value,...] [--lead s] [--probs node] [--stretches]');
  process.exit(1);
}
const rec = JSON.parse(readFileSync(file, 'utf8'));
const la = rec.lookahead;
if (!la?.ticks?.wall.length) {
  console.error(`${file}: no look-ahead ticks in it (recorded listening live, or before version 2)`);
  process.exit(1);
}

const overrides = Object.fromEntries((opt('--set', '') || '').split(',').filter(Boolean).map((kv) => {
  const [k, v] = kv.split('=');
  return [k, Number(v)];
}));
const settings = { ...DEFAULTS, ...rec.settings };
const look = { ...LOOKAHEAD, ...rec.lookaheadParams };
for (const [k, v] of Object.entries(overrides)) {
  if (k in look) look[k] = v;
  else if (k in settings) settings[k] = v;
  else {
    console.error(`--set: no setting or look-ahead parameter ${k}`);
    process.exit(1);
  }
}

// --- What happened in the browser
const t = la.ticks;
const pct = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const st = la.status;
const last = st.at(-1) ?? {};
console.log(`${file}`);
console.log(`  ${rec.url ?? ''}`);
console.log(`  ${rec.userAgent ?? ''}`);
console.log(`  recorded ${rec.created}: ${t.wall.length} ticks over ${t.wall.at(-1).toFixed(1)} s, media ${Math.min(...t.mediaTime).toFixed(1)}–${Math.max(...t.mediaTime).toFixed(1)} s`);
console.log(`  buffers ${JSON.stringify(last.buffers ?? [])}, error ${last.error ?? 'none'}, counts ${JSON.stringify(last.counts ?? {})}`);
const aheads = st.map((s) => s.ahead).filter(Number.isFinite);
console.log(`  analysed ahead: min ${pct(aheads, 0)?.toFixed(1)} s, median ${pct(aheads, 0.5)?.toFixed(1)} s; speed changes took ${last.lagMs ?? '?'} ms (lead ${last.leadMs ?? '?'} ms)`);
const frames = la.frames;
console.log(`  frames: ${frames.p.length} analysed around what played, ${frames.audio.filter(Boolean).length} with audio`);
const unknown = t.at.filter((x) => x === null).length;
if (unknown) console.log(`  ticks without an answer (analysis not far enough ahead): ${unknown}`);
for (const e of rec.events.filter((x) => x.type !== 'settings')) console.log(`  event at ${e.wall?.toFixed(2)} s: ${e.type} ${JSON.stringify({ ...e, frame: undefined, wall: undefined, type: undefined })}`);

// --- The timeline: the browser's probabilities, or Silero's under Node
const timeline = createTimeline();
if (opt('--probs', 'browser') === 'node') {
  const require = createRequire(new URL('../package.json', import.meta.url));
  const mod = await import(require.resolve('onnxruntime-web'));
  const ort = mod.default ?? mod;
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  const model = await createModel(ort, readFileSync(opt('--model', new URL('../assets/silero_vad.onnx', import.meta.url).pathname)));
  const pcm = decodePcm(rec, { lookahead: true });
  const stream = model.createStream();
  let a = 0;
  let prev = null;
  let missing = 0;
  for (let k = 0; k < frames.p.length; k++) {
    if (!frames.audio[k]) {
      // No audio for it: the browser's probability, and the model starts afresh after
      timeline.set(frames.mediaTime[k], frames.p[k]);
      missing++;
      prev = null;
      continue;
    }
    if (prev === null || Math.abs(frames.mediaTime[k] - prev - FRAME_SEC) > 0.002) stream.reset();
    prev = frames.mediaTime[k];
    timeline.set(frames.mediaTime[k], await stream.process(pcm.subarray(a * 512, (a + 1) * 512)));
    a++;
  }
  if (missing) console.log(`  --probs node: ${missing} frames had no audio; the browser's probabilities stand for them`);
} else {
  frames.mediaTime.forEach((m, k) => timeline.set(m, frames.p[k]));
}

// --- The schedule again, over the recorded ticks
const schedule = createSchedule(timeline, settings, PARAMS, look);
const seeks = rec.events.filter((e) => e.type === 'reset' && e.reason === 'seek').map((e) => e.wall);
const leadAt = (wall) => {
  if (opt('--lead', null) !== null) return +opt('--lead');
  let ms = null;
  for (const s of st) if (s.wall <= wall && s.leadMs !== null) ms = s.leadMs;
  return ms === null ? look.leadSec : ms / 1000;
};
// The browser's schedule had been running before the recording started:
// bring this one to the same state over what was analysed before the first
// tick
const first = t.mediaTime[0];
for (let m = first - KEEP_BEHIND_SEC; m < first; m += 0.03) schedule.at(m, leadAt(0));
const replayed = [];
let seek = 0;
for (let i = 0; i < t.wall.length; i++) {
  while (seek < seeks.length && seeks[seek] <= t.wall[i]) {
    schedule.reset(t.mediaTime[i]);
    seek++;
  }
  replayed.push(schedule.at(t.mediaTime[i], leadAt(t.wall[i])));
}

// Talk stretches in media time: runs of ticks at talk speed (the browser
// plays talk speed where the schedule doesn't know yet, too), broken by seeks
function stretches(answers) {
  const out = [];
  let cur = null;
  for (let i = 0; i < answers.length; i++) {
    if (i > 0 && Math.abs(t.mediaTime[i] - t.mediaTime[i - 1]) > 1) cur = null;
    if (answers[i] === 'gameplay') {
      cur = null;
    } else if (cur) {
      cur.to = t.mediaTime[i];
    } else {
      cur = { from: t.mediaTime[i], to: t.mediaTime[i] };
      out.push(cur);
    }
  }
  return out;
}
const before = stretches(t.at);
const after = stretches(replayed);
const differ = replayed.filter((x, i) => x !== t.at[i]).length;
const talkSec = (a) => a.reduce((s, x) => s + x.to - x.from, 0);
console.log('');
console.log(`settings: play ${settings.playSpeed}x, talk ${settings.talkSpeed}x, wait ${settings.waitSec} s, sensitivity ${settings.sensitivity}, minFrames ${look.minFrames}, lead ${opt('--lead', null) ?? 'as recorded'}`);
console.log(`  in the browser: ${before.length} talk stretches, ${talkSec(before).toFixed(1)} s of media at talk speed`);
console.log(`  replayed:       ${after.length} talk stretches, ${talkSec(after).toFixed(1)} s of media at talk speed; ${differ} of ${t.wall.length} ticks answer differently`);
if (args.includes('--stretches')) {
  for (const [name, list] of [['browser', before], ['replayed', after]]) {
    console.log(`  ${name}:`);
    for (const s of list) {
      const first = [...timeline.from(s.from - 1)].filter(([m, p]) => m >= s.from && m <= s.to && p >= PARAMS.startLow - settings.sensitivity * PARAMS.sensitivityStep).sort((a, b) => a[0] - b[0])[0];
      console.log(`    ${s.from.toFixed(2)}–${s.to.toFixed(2)} s${first ? `, speech from ${first[0].toFixed(2)} s` : ', no speech in it'}`);
    }
  }
}
