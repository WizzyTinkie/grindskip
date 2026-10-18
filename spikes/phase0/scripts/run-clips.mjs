// Spike 2, browser half: plays each clip at each speed on the local player
// page, captures it through the extension's planned path and runs Silero in
// the content script. The browser does its own time-stretching, which is
// what ffmpeg's atempo stands in for offline.
//
// Writes results/traces-<browser>.json (same format as traces-ffmpeg.json,
// scored by analyze.mjs) and the analysed 16 kHz audio as WAV files in
// results/pcm-<browser>/ for offline replay with other models.
//
// Media time: each frame's end is mapped to media time through the
// playbackRate and video.currentTime at the polls, then shifted by the
// capture latency, which is estimated by aligning the trace with the clip's
// 1x ffmpeg trace.
//
// Usage: node scripts/run-clips.mjs chrome|firefox [--speeds 1,2,2.5,3,4] [--clips a,b]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { launch, startServer, nullSink, cmd, waitForSpike, sleep } from '../lib/harness.mjs';
import { CLIPS, CLIP_SEC } from '../lib/clips.mjs';
import { median } from '../lib/metrics.mjs';

const [browserName, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const speeds = opt('--speeds', '1,2,2.5,3,4').split(',').map(Number);
const clipNames = opt('--clips', CLIPS.map((c) => c.name).join(',')).split(',');
const model = 'silero_vad_v6.2_16k';
const FRAME_SEC = 0.032;

const ffmpegRef = new Map(JSON.parse(readFileSync('results/traces-ffmpeg.json', 'utf8'))
  .filter((t) => t.speed === 1 && t.model === model).map((t) => [t.clip, t.probs]));

function wav16k(i16) {
  const b = Buffer.alloc(44 + i16.byteLength);
  b.write('RIFF', 0); b.writeUInt32LE(36 + i16.byteLength, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(i16.byteLength, 40);
  Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).copy(b, 44);
  return b;
}

// Pearson correlation of the trace with the 1x reference at a latency shift
function corrAt(mediaEnd, probs, ref, shift) {
  const xs = [], ys = [];
  for (let k = 0; k < probs.length; k++) {
    const i = Math.floor((mediaEnd[k] - shift) / FRAME_SEC - 0.5);
    if (i < 0 || i >= ref.length || mediaEnd[k] - shift > CLIP_SEC - 0.5) continue;
    xs.push(probs[k]); ys.push(ref[i]);
  }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

function toTrace(clip, speed, r) {
  const sr = r.sampleRate;
  // currentTime minus rate * input samples, over the polls while playing
  const playing = r.polls.filter((p) => !p.paused && p.currentTime > 0.5 && p.currentTime < CLIP_SEC - 0.5);
  const offset = median(playing.map((p) => p.currentTime - p.rate * p.cum / sr));
  const mediaRaw = r.frames.map((_, k) => offset + speed * ((k + 1) * 512 * sr / 16000) / sr);
  const ref = ffmpegRef.get(clip.name);
  let best = { shift: 0, c: -Infinity };
  for (let shift = -0.2; shift <= 0.6; shift += 0.004) {
    const c = corrAt(mediaRaw, r.frames.map((f) => f.p), ref, shift);
    if (c > best.c) best = { shift, c };
  }
  const keep = r.frames.map((_, k) => mediaRaw[k] - best.shift).map((m) => m > 0 && m <= CLIP_SEC);
  return {
    trace: {
      source: browserName, model, clip: clip.name, speed,
      msPerFrame: r.cost.inferMs.mean,
      mediaEnd: mediaRaw.map((m) => +(m - best.shift).toFixed(4)).filter((_, k) => keep[k]),
      probs: r.frames.map((f) => Math.round(f.p * 1000) / 1000).filter((_, k) => keep[k]),
    },
    // media seconds between currentTime and the analysed audio
    captureLatencyMediaSec: +best.shift.toFixed(3),
    alignCorr: +best.c.toFixed(3),
  };
}

const unload = nullSink();
const server = await startServer();
const { browser } = await launch(browserName);
const traces = [];
const runs = [];
mkdirSync(`results/pcm-${browserName}`, { recursive: true });
try {
  for (const clip of CLIPS.filter((c) => clipNames.includes(c.name))) {
    for (const speed of speeds) {
      const page = await browser.newPage();
      await page.goto(`${server.url}/pages/player.html?src=/${clip.file}`, { waitUntil: 'load' });
      await waitForSpike(page);
      await page.waitForFunction(() => document.getElementById('v').readyState >= 3, { timeout: 20000 });
      await page.evaluate((s) => { const v = document.getElementById('v'); v.playbackRate = s; v.currentTime = 0; }, speed);
      const start = await cmd(page, 'captureStart', { model, keepPcm: true });
      await page.evaluate(() => document.getElementById('v').play());
      const t0 = Date.now();
      await page.waitForFunction((end) => { const v = document.getElementById('v'); return v.ended || v.currentTime >= end; },
        { timeout: (CLIP_SEC / speed + 30) * 1000, polling: 250 }, CLIP_SEC - 0.05);
      await sleep(300);
      const r = await cmd(page, 'captureStop');
      await page.close();
      const { trace, captureLatencyMediaSec, alignCorr } = toTrace(clip, speed, r);
      traces.push(trace);
      const i16 = new Int16Array(Buffer.from(r.pcm16, 'base64').buffer.slice(0));
      writeFileSync(`results/pcm-${browserName}/${clip.name}-${speed}x.wav`, wav16k(i16));
      const run = {
        clip: clip.name, speed, method: start.method, sampleRate: r.sampleRate,
        wallSec: (Date.now() - t0) / 1000, frames: r.frames.length, overflow: r.overflow,
        captureLatencyWallSec: +(captureLatencyMediaSec / speed).toFixed(3), alignCorr, cost: r.cost,
      };
      runs.push(run);
      console.log(`${browserName} ${clip.name} ${speed}x: ${r.frames.length} frames, latency ${(captureLatencyMediaSec / speed * 1000).toFixed(0)} ms (corr ${alignCorr}), `
        + `busy ${r.cost.busyMsPerSec.toFixed(1)} ms/s, infer ${r.cost.inferMs.mean.toFixed(3)} ms, overflow ${r.overflow}`);
    }
  }
} finally {
  writeFileSync(`results/traces-${browserName}.json`, JSON.stringify(traces));
  writeFileSync(`results/runs-${browserName}.json`, JSON.stringify(runs, null, 1));
  console.log(`wrote results/traces-${browserName}.json and results/runs-${browserName}.json`);
  await browser.close();
  await server.close();
  unload();
}
