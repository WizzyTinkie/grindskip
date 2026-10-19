// Scores the controller on the browser recordings (record.mjs), replayed
// closed-loop offline (lib/simulate.js), against the caption labels.
//
// Usage: node run.mjs [options]
//   --browsers chrome,firefox   which recordings (default: both)
//   --clips a,b                 which clips (default: all)
//   --play 2.5                  gameplay speed(s), comma-separated (default 2.5)
//   --set key=value             override a setting (waitSec, sensitivity, rewind)
//                               or a controller parameter (startHigh, end, ...)
//   --probs browser|node        the browser's probabilities (default), or
//                               Silero rerun under Node on the recorded audio
//   --model path.onnx           with --probs node: another model
//   --sweep                     search the thresholds for each gameplay speed
//   --labels                    check the caption labels against the 1x model output
//   --audible                   score only the labelled speech the model hears at
//                               1x (above 0.5 somewhere in it), to leave out
//                               caption words no threshold could catch
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PARAMS, minSpeechFrames } from '../src/controller/controller.js';
import { DEFAULTS } from '../src/shared/settings.js';
import { createModel } from '../src/vad/silero.js';
import { decodePcm } from '../src/content/recorder.js';
import { CLIPS } from './lib/clips.mjs';
import { labelsFor } from './lib/labels.mjs';
import { combine, score, simulate, source } from './lib/simulate.js';

const EVAL = new URL('./', import.meta.url);
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const browsers = opt('--browsers', 'chrome,firefox').split(',');
const clips = (opt('--clips', null)?.split(',') ?? CLIPS.map((c) => c.name)).map((n) => CLIPS.find((c) => c.name === n));
const plays = opt('--play', '2.5').split(',').map(Number);
const probs = opt('--probs', 'browser');

// --set overrides, split into settings and controller parameters
const settingsOver = {};
const paramsOver = {};
args.forEach((a, i) => {
  if (a !== '--set') return;
  const [k, v] = args[i + 1].split('=');
  const value = v === 'true' ? true : v === 'false' ? false : Number(v);
  if (k in DEFAULTS) settingsOver[k] = value;
  else if (k in PARAMS) paramsOver[k] = value;
  else throw new Error(`unknown setting or parameter ${k}`);
});

// --- Recordings and labels

let model = null;
async function nodeProbs(rec) {
  if (!model) {
    const require = createRequire(new URL('../package.json', import.meta.url));
    const mod = await import(require.resolve('onnxruntime-web'));
    const ort = mod.default ?? mod;
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    model = await createModel(ort, readFileSync(opt('--model', new URL('../assets/silero_vad.onnx', import.meta.url).pathname)));
  }
  const pcm = decodePcm(rec);
  const resets = new Set(rec.events.filter((e) => e.type === 'reset').map((e) => e.frame));
  const stream = model.createStream();
  const out = new Float32Array(rec.frames.p.length);
  for (let k = 0; k < out.length; k++) {
    if (resets.has(k)) stream.reset();
    out[k] = await stream.process(pcm.subarray(k * 512, (k + 1) * 512));
  }
  return out;
}

// { [clip]: { [speed]: source } } for one browser, and the browser's
// inference times
async function loadBrowser(browser) {
  const out = {};
  const inferMs = [];
  for (const clip of clips) {
    out[clip.name] = {};
    for (const file of [1, 2, 2.5, 3, 4].map((s) => [s, join(EVAL.pathname, 'recordings', browser, `${clip.name}-${s}x.json`)])) {
      const [speed, path] = file;
      if (!existsSync(path)) continue;
      const rec = JSON.parse(readFileSync(path, 'utf8'));
      const p = probs === 'node' ? await nodeProbs(rec) : rec.frames.p;
      // Only the frames played at the recording's speed (not the first
      // ones, before the speed was set) and with a probability
      const keep = rec.frames.p.map((x, k) => x !== null && rec.frames.rate[k] === speed && rec.frames.mediaTime[k] !== null);
      const media = Float64Array.from(rec.frames.mediaTime.filter((_, k) => keep[k]));
      out[clip.name][speed] = source(media, Float32Array.from(Array.from(p).filter((_, k) => keep[k])));
      inferMs.push(...rec.frames.inferMs.filter((x) => x !== null));
    }
  }
  return { sources: out, inferMs };
}

const data = {};
for (const b of browsers) data[b] = await loadBrowser(b);
const labels = Object.fromEntries(clips.map((c) => {
  let iv = labelsFor(c, EVAL);
  if (args.includes('--audible')) {
    // Heard in every browser's 1x recording
    iv = iv.filter(([a, b]) => browsers.every((br) => {
      const src = data[br].sources[c.name][1];
      return src.p.some((p, k) => p > 0.5 && src.media[k] > a && src.media[k] <= b + 0.1);
    }));
  }
  return [c.name, iv];
}));

// --- Scoring

function run(settings, params, browser) {
  const per = {};
  for (const clip of clips) {
    const srcs = data[browser].sources[clip.name];
    if (!srcs[settings.talkSpeed] || !srcs[settings.playSpeed]) throw new Error(`${browser} ${clip.name}: no recording at ${settings.talkSpeed}x or ${settings.playSpeed}x`);
    per[clip.name] = score(simulate(srcs, settings, params), labels[clip.name], settings);
  }
  return { per, all: combine(Object.values(per)) };
}

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '–');
const sec = (x) => (Number.isFinite(x) ? `${x.toFixed(2)} s` : '–');

function row(name, s) {
  const fs = Number.isFinite(s.falseSlowdownsPerMin) ? s.falseSlowdownsPerMin
    : s.quietMin ? s.falseSlowdowns / s.quietMin : NaN;
  const delays = s.delays ? [...s.delays].sort((a, b) => a - b) : null;
  const median = s.medianDelay ?? (delays?.length ? delays[delays.length >> 1] : NaN);
  return `| ${name} | ${pct(s.speechAtTalkSpeed)} | ${pct(s.quietAtGameplaySpeed)} | ${s.falseSlowdowns} in ${s.quietMin.toFixed(1)} min (${Number.isFinite(fs) ? fs.toFixed(2) : '–'}/min) | ${sec(median)} | ${s.missed} |`;
}

function report(settings, params) {
  const head = '| clip | speech at talk speed | quiet at gameplay speed | false slowdowns | median delay | missed onsets |\n|---|---|---|---|---|---|';
  for (const b of browsers) {
    const { per, all } = run(settings, params, b);
    console.log(`\n### ${b}, ${settings.playSpeed}x\n\n${head}`);
    for (const [name, s] of Object.entries(per)) console.log(row(name, s));
    console.log(row('**all**', all));
  }
}

function cpu() {
  console.log('\n### Inference per frame in the browser (content script, including the wait for its turn)\n');
  for (const b of browsers) {
    const xs = [...data[b].inferMs].sort((x, y) => x - y);
    const q = (f) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))];
    const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
    console.log(`- ${b}: mean ${mean.toFixed(2)} ms, p50 ${q(0.5).toFixed(2)}, p99 ${q(0.99).toFixed(2)} ms over ${xs.length} frames: ${(mean / 32 * 100).toFixed(1)}% of one core`);
  }
}

// How well the captions line up with what the model hears at 1x: the
// share of labelled speech the model scores above 0.5, the share of the
// rest it scores below, and the caption offset that agrees best
function checkLabels() {
  console.log('\n| browser | clip | speech in labels | model > 0.5 in labelled speech | model < 0.5 elsewhere | best caption shift |\n|---|---|---|---|---|---|');
  for (const b of browsers) {
    for (const clip of clips) {
      const src = data[b].sources[clip.name][1];
      if (!src) continue;
      const agree = (shift) => {
        let tp = 0; let sp = 0; let tn = 0; let ns = 0;
        for (let k = 0; k < src.media.length; k++) {
          const m = src.media[k] - 0.016;
          const isSpeech = labels[clip.name].some(([a, bb]) => m >= a + shift && m < bb + shift);
          if (isSpeech) { sp++; if (src.p[k] > 0.5) tp++; } else { ns++; if (src.p[k] <= 0.5) tn++; }
        }
        return { tpr: tp / sp, tnr: tn / ns, share: sp / (sp + ns), bal: (tp / sp + tn / ns) / 2 };
      };
      let best = { shift: 0, ...agree(0) };
      for (let s = -1; s <= 1.0001; s += 0.05) {
        const a = agree(s);
        if (a.bal > best.bal) best = { shift: s, ...a };
      }
      const a0 = agree(0);
      console.log(`| ${b} | ${clip.name} | ${pct(a0.share)} | ${pct(a0.tpr)} | ${pct(a0.tnr)} | ${best.shift.toFixed(2)} s (${pct(best.bal)} vs ${pct(a0.bal)}) |`);
    }
  }
}

// Grid search over the thresholds at one gameplay speed. Some labelled
// onsets can't be caught at any threshold (see REPORT.md), so rather than
// pass or fail the targets, it prints the combinations no other one beats on
// all of: false slowdowns (both browsers added up), speech kept at talk
// speed and median delay (the worse browser), with quiet media at gameplay
// speed at least 90%.
function sweep(play) {
  const grid = {
    startLow: [0.4, 0.5, 0.6],
    startHigh: [0.6, 0.7, 0.8, 0.85, 0.9],
    end: [0.25, 0.35, 0.45],
    minSpeechFrames: [1, 2, 3, 4, 6],
  };
  const keys = Object.keys(grid);
  const combos = keys.reduce((acc, k) => acc.flatMap((a) => grid[k].map((v) => ({ ...a, [k]: v }))), [{}])
    .filter((c) => c.end < c.startLow);
  const results = combos.map((acc) => {
    // The swept minimum applies at this speed, whichever side of fastRate
    const params = { ...PARAMS, ...paramsOver, ...acc, minSpeechFramesFast: acc.minSpeechFrames };
    const settings = { ...DEFAULTS, ...settingsOver, playSpeed: play };
    const alls = browsers.map((b) => run(settings, params, b).all);
    return {
      acc,
      alls,
      fs: alls.reduce((a, x) => a + x.falseSlowdowns, 0),
      speech: Math.min(...alls.map((x) => x.speechAtTalkSpeed)),
      delay: Math.max(...alls.map((x) => x.medianDelay)),
      quiet: Math.min(...alls.map((x) => x.quietAtGameplaySpeed)),
    };
  }).filter((r) => r.quiet >= 0.9);
  const beats = (a, b) => a.fs <= b.fs && a.speech >= b.speech && a.delay <= b.delay
    && (a.fs < b.fs || a.speech > b.speech || a.delay < b.delay);
  const front = results.filter((r) => !results.some((o) => beats(o, r)))
    .sort((a, b) => (a.fs - b.fs) || (b.speech - a.speech) || (a.delay - b.delay));
  console.log(`\n### Sweep at ${play}x: ${front.length} of ${results.length} combinations unbeaten\n`);
  console.log(`| startLow | startHigh | end | min frames | ${browsers.map((b) => `${b}: speech / quiet / false / delay`).join(' | ')} |`);
  console.log(`|---|---|---|---|${browsers.map(() => '---').join('|')}|`);
  const show = (r) => console.log(`| ${r.acc.startLow} | ${r.acc.startHigh} | ${r.acc.end} | ${r.acc.minSpeechFrames} | ${r.alls.map((x) => `${pct(x.speechAtTalkSpeed)} / ${pct(x.quietAtGameplaySpeed)} / ${x.falseSlowdowns} / ${sec(x.medianDelay)}`).join(' | ')} |`);
  front.slice(0, 15).forEach(show);
  const now = { ...PARAMS, minSpeechFrames: minSpeechFrames(play) };
  const current = results.find((r) => keys.every((k) => r.acc[k] === now[k]));
  if (current) {
    console.log(`\nCurrent${front.includes(current) ? ' (unbeaten)' : ''}:`);
    show(current);
  }
}

if (args.includes('--labels')) checkLabels();
else if (args.includes('--sweep')) for (const play of plays) sweep(play);
else {
  for (const play of plays) report({ ...DEFAULTS, ...settingsOver, playSpeed: play }, { ...PARAMS, ...paramsOver });
  cpu();
}
await model?.release();
