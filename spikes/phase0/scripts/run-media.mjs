// Spike 4 (and the same checks in Chrome): with the sweep video on the local
// test page and the browser playing into a null sink,
//   audible: is the element still heard after captureStream() /
//            mozCaptureStream(), and after also routing the capture to the
//            AudioContext's output?
//   lag:     after a playbackRate change, how long until the captured audio
//            and video.currentTime run at the new rate?
//   mute:    above which rate does the audio go silent (captured and heard)?
//
// The sweep's frequency rises 100 Hz per media second from 300 Hz, so the
// tone in the captured audio tells which media time is playing.
//
// Usage: node scripts/run-media.mjs chrome|firefox [audible] [lag] [mute] [--mse]
//   --mse  feed the video through Media Source Extensions, like YouTube
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, startServer, nullSink, recordSink, sleep } from '../lib/harness.mjs';

const [browserName, ...rest] = process.argv.slice(2);
const mse = rest.includes('--mse');
const tests = rest.filter((a) => !a.startsWith('--'));
const run = tests.length ? tests : ['audible', 'lag', 'mute'];

const unload = nullSink();
const server = await startServer();
const { browser } = await launch(browserName, { extension: null });
const report = { browser: browserName, mse };

async function openPage() {
  const page = await browser.newPage();
  await page.goto(`${server.url}/pages/mediatest.html${mse ? '?mse=1' : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('v').readyState >= 3, { timeout: 20000 });
  return page;
}

const play = (page) => page.evaluate(() => { mt.log('play'); return document.getElementById('v').play(); });

async function dump(page) {
  const d = JSON.parse(await page.evaluate(() => mt.dump()));
  const b = Buffer.from(d.pcm16, 'base64');
  const i16 = new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
  d.samples = Float32Array.from(i16, (x) => x / 32768);
  delete d.pcm16;
  return d;
}

function rms(a, from, to) {
  from = Math.max(0, Math.floor(from));
  to = Math.min(a.length, Math.floor(to));
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return to > from ? Math.sqrt(s / (to - from)) : NaN;
}
const db = (x) => +(20 * Math.log10(x + 1e-9)).toFixed(1);

// Epoch (ms) of each sink sample: aligned on the first sound after `play`
function sinkClock(rec, playEpoch) {
  const a = rec.samples;
  let onset = 0;
  for (let i = 0; i < a.length; i += 48) if (Math.abs(a[i]) > 0.01) { onset = i; break; }
  return { toIndex: (epoch) => onset + (epoch - playEpoch) / 1000 * 48000 };
}

// ---- audible ----
async function audible(method) {
  const page = await openPage();
  const rec = recordSink();
  await sleep(500);
  await play(page);
  await sleep(2500);
  const setup = await page.evaluate((m) => mt.setup({ method: m }), method).catch((e) => ({ error: String(e) }));
  await sleep(2500);
  if (!setup.error) await page.evaluate(() => mt.connectOut());
  await sleep(2500);
  const sink = await rec.stop();
  const d = await dump(page);
  await page.close();
  const ev = (n) => d.events.find((e) => e.name === n);
  const clock = sinkClock(sink, ev('play').epoch);
  const win = (name) => {
    const e = ev(name);
    if (!e) return null;
    return db(rms(sink.samples, clock.toIndex(e.epoch + 500), clock.toIndex(e.epoch + 2300)));
  };
  return {
    method, setup,
    heardDb: { beforeCapture: win('play'), whileCaptured: win('setup'), capturedAndRoutedToOutput: win('connectOut') },
    capturedDb: d.samples.length ? db(rms(d.samples, d.sampleRate * 0.5, d.samples.length)) : null,
  };
}

// ---- frequency tracking ----
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

// Media time every 10 ms of captured audio, from the sweep's frequency
function mediaTrack(d) {
  const N = 4096;
  const sr = d.sampleRate;
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  // ctx time of sample i, from the poll that delivered it
  const polls = d.polls;
  let j = 0;
  const ctxOf = (i) => {
    while (j < polls.length - 1 && polls[j].cum <= i) j++;
    while (j > 0 && polls[j - 1].cum > i) j--;
    return polls[j].ctxTime - (polls[j].cum - i) / sr;
  };
  const out = [];
  for (let c = N / 2; c + N / 2 < d.samples.length; c += sr / 100) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = d.samples[c - N / 2 + i] * hann[i];
    fft(re, im);
    let best = 1, bestMag = 0;
    const mag = (k) => Math.hypot(re[k], im[k]);
    for (let k = 1; k < N / 2 - 1; k++) { const m = mag(k); if (m > bestMag) { bestMag = m; best = k; } }
    const a = Math.log(mag(best - 1) + 1e-12), b = Math.log(bestMag + 1e-12), g = Math.log(mag(best + 1) + 1e-12);
    const f = (best + 0.5 * (a - g) / (a - 2 * b + g)) * sr / N;
    if (bestMag < 1) continue; // silence
    out.push({ t: ctxOf(Math.round(c)), m: (f - 300) / 100 });
  }
  return out;
}

// Fits m(t) = m0 + r0 (t - tE) before tE + L and continues at r1 after it,
// and returns the L (s) with the least squared error
function fitLag(points, tE, r0, r1) {
  const pts = points.filter((p) => p.t > tE - 0.6 && p.t < tE + 1.2);
  if (pts.length < 20) return null;
  let best = { err: Infinity, L: null };
  for (let L = -0.1; L <= 1.0; L += 0.005) {
    const ts = tE + L;
    // m0 by least squares for this L
    const pred = (p) => (p.t < ts ? r0 * (p.t - ts) : r1 * (p.t - ts));
    const m0 = pts.reduce((s, p) => s + p.m - pred(p), 0) / pts.length;
    const err = pts.reduce((s, p) => s + (p.m - m0 - pred(p)) ** 2, 0);
    if (err < best.err) best = { err, L };
  }
  return +best.L.toFixed(3);
}

async function lag() {
  const page = await openPage();
  await page.evaluate(() => mt.setup({ method: 'captureStream' }));
  await play(page);
  const plan = [[2, 2.5], [5, 1], [8, 4], [11, 1], [14, 2], [17, 1], [20, 3], [23, 1]];
  const t0 = Date.now();
  for (const [at, rate] of plan) {
    await sleep(Math.max(0, t0 + at * 1000 - Date.now()));
    await page.evaluate((r) => mt.setRate(r), rate);
  }
  await sleep(3000);
  const d = await dump(page);
  await page.close();
  const track = mediaTrack(d);
  const pollPts = d.polls.map((p) => ({ t: p.ctxTime, m: p.currentTime }));
  const rates = d.events.filter((e) => e.name === 'rate');
  const changes = [];
  let prev = 1;
  for (const e of rates) {
    changes.push({ from: prev, to: e.rate, audioLagMs: Math.round(1000 * fitLag(track, e.ctxTime, prev, e.rate)), currentTimeLagMs: Math.round(1000 * fitLag(pollPts, e.ctxTime, prev, e.rate)) });
    prev = e.rate;
  }
  return { changes, trackPoints: track.length };
}

async function mute() {
  const page = await openPage();
  await page.evaluate(() => { document.getElementById('v').loop = true; return mt.setup({ method: 'captureStream' }); });
  const rec = recordSink();
  await sleep(500);
  await play(page);
  const rates = [1, 2, 3, 3.5, 3.9, 4, 4.01, 4.1, 4.5, 5, 6, 8, 12, 16, 1];
  const steps = [];
  for (const r of rates) {
    const res = await page.evaluate((x) => mt.setRate(x), r);
    steps.push({ rate: r, ...res });
    await sleep(1500);
  }
  const sink = await rec.stop();
  const d = await dump(page);
  await page.close();
  const evs = d.events.filter((e) => e.name === 'rate');
  const clock = sinkClock(sink, d.events.find((e) => e.name === 'play').epoch);
  const ctxIndex = (ctxTime) => {
    const p = d.polls.find((q) => q.ctxTime >= ctxTime) ?? d.polls.at(-1);
    return p.cum - (p.ctxTime - ctxTime) * d.sampleRate;
  };
  return steps.map((s, i) => ({
    ...s,
    capturedDb: db(rms(d.samples, ctxIndex(evs[i].ctxTime + 0.6), ctxIndex(evs[i].ctxTime + 1.4))),
    heardDb: db(rms(sink.samples, clock.toIndex(evs[i].epoch + 600), clock.toIndex(evs[i].epoch + 1400))),
  }));
}

try {
  if (run.includes('audible')) {
    report.audible = [await audible('captureStream')];
    if (browserName === 'firefox') report.audible.push(await audible('mozCaptureStream'));
    console.log('audible:', JSON.stringify(report.audible, null, 1));
  }
  if (run.includes('lag')) {
    report.lag = await lag();
    console.log('lag:', JSON.stringify(report.lag, null, 1));
  }
  if (run.includes('mute')) {
    report.mute = await mute();
    console.log('mute:'); for (const s of report.mute) console.log(' ', JSON.stringify(s));
  }
} finally {
  mkdirSync('results', { recursive: true });
  const file = `results/media-${browserName}${mse ? '-mse' : ''}.json`;
  writeFileSync(file, JSON.stringify(report, null, 1));
  console.log(`wrote ${file}`);
  await browser.close();
  await server.close();
  unload();
}
