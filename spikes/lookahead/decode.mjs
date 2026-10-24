// Look-ahead, decoding: can the browser decode the audio captured from
// YouTube's appends, and does Silero hear the same in it as in the audio
// the extension captured while playing? Demuxes the saved appends
// (webm.js) and decodes them with WebCodecs' AudioDecoder in the browser,
// then runs Silero under Node on the result and compares it with the 1x
// recording of the same video from Phase 3 (the risen clip is the start of
// BFG1Q7zpNtE).
//
// Usage: node spikes/lookahead/decode.mjs chrome|firefox [--from chrome]
//   --from: whose saved appends to decode (default: the same browser's)
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startServer } from '../../eval/lib/harness.mjs';
import { createFramer, createResampler } from '../../src/vad/resample.js';
import { createModel } from '../../src/vad/silero.js';

const require = createRequire(new URL('../../eval/package.json', import.meta.url));
const puppeteer = require('puppeteer');
const [browserName, ...rest] = process.argv.slice(2);
const from = rest.includes('--from') ? rest[rest.indexOf('--from') + 1] : browserName;
const DIR = import.meta.dirname;

const files = readdirSync(join(DIR, 'results')).filter((f) => f.startsWith(`${from}-audio-`)).sort((a, b) => parseInt(a.split('-')[2]) - parseInt(b.split('-')[2]));
const appends = files.map((f) => readFileSync(join(DIR, 'results', f)).toString('base64'));

const server = await startServer();
const browser = browserName === 'chrome'
  ? await puppeteer.launch({ browser: 'chrome', headless: true, pipe: true, args: ['--mute-audio'] })
  : await puppeteer.launch({ browser: 'firefox', executablePath: '/usr/bin/firefox', headless: true });
let decoded;
try {
  const page = await browser.newPage();
  // Any page on 127.0.0.1: WebCodecs needs a secure context
  await page.goto(`${server.url}/pages/player.html`, { waitUntil: 'load' });
  await page.addScriptTag({ type: 'module', content: `${readFileSync(join(DIR, 'webm.js'), 'utf8')}\nwindow.createWebmDemuxer = createWebmDemuxer;` });
  await page.waitForFunction(() => window.createWebmDemuxer);
  decoded = await page.evaluate(async (appends) => {
    const t0 = performance.now();
    const demux = window.createWebmDemuxer();
    const frames = [];
    for (const b64 of appends) frames.push(...demux.push(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    const track = [...demux.tracks.values()][0];
    const config = { codec: 'opus', sampleRate: track.sampleRate, numberOfChannels: track.channels, description: track.setup };
    const support = await AudioDecoder.isConfigSupported(config);
    const parts = [];
    let firstTimestamp = null;
    const decoder = new AudioDecoder({
      output: (data) => {
        firstTimestamp ??= data.timestamp / 1e6;
        const n = data.numberOfFrames;
        const mono = new Float32Array(n);
        const plane = new Float32Array(n);
        for (let c = 0; c < data.numberOfChannels; c++) {
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let i = 0; i < n; i++) mono[i] += plane[i] / data.numberOfChannels;
        }
        parts.push(mono);
        data.close();
      },
      error: (e) => { throw e; },
    });
    decoder.configure(config);
    const t1 = performance.now();
    for (const f of frames) decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(f.timestamp * 1e6), data: f.data }));
    await decoder.flush();
    const t2 = performance.now();
    const total = parts.reduce((a, p) => a + p.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    const bytes = new Uint8Array(all.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return {
      supported: support.supported,
      frames: frames.length,
      seconds: total / track.sampleRate,
      sampleRate: track.sampleRate,
      firstTimestamp,
      demuxMs: t1 - t0,
      decodeMs: t2 - t1,
      pcm: btoa(s),
    };
  }, appends);
} finally {
  await browser.close();
  await server.close();
}

const pcm = new Float32Array(Buffer.from(decoded.pcm, 'base64').buffer.slice(0));
delete decoded.pcm;
console.log(browserName, `(appends from ${from})`, JSON.stringify(decoded));

// Silero on the decoded audio, at 1x, as look-ahead would run it
const mod = await import(require.resolve('onnxruntime-web'));
const ort = mod.default ?? mod;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
const model = await createModel(ort, readFileSync(new URL('../../assets/silero_vad.onnx', import.meta.url)));
const stream = model.createStream();
const resampler = createResampler(decoded.sampleRate, 16000);
const framer = createFramer(512);
const chunks = [];
framer.push(resampler.push(pcm), (f) => chunks.push(f.slice()));
const t0 = performance.now();
const ours = [];
for (let k = 0; k < chunks.length; k++) ours.push({ m: decoded.firstTimestamp + (k + 1) * 0.032, p: await stream.process(chunks[k]) });
const inferMs = (performance.now() - t0) / chunks.length;

// The Phase 3 recording of the same audio, captured while playing at 1x
const rec = JSON.parse(readFileSync(new URL(`../../eval/recordings/${browserName}/risen-1x.json`, import.meta.url), 'utf8'));
const theirs = rec.frames.mediaTime.map((m, k) => ({ m, p: rec.frames.p[k] })).filter((x) => x.m !== null && x.p !== null);
const at = (m) => {
  let best = theirs[0];
  for (const x of theirs) if (Math.abs(x.m - m) < Math.abs(best.m - m)) best = x;
  return best;
};
// The recording's media times run a little behind its audio; find the shift
let best = null;
for (let s = -0.3; s <= 0.3001; s += 0.016) {
  const pairs = ours.filter((x) => x.m > 0.5).map((x) => [x.p, at(x.m + s).p]);
  const mae = pairs.reduce((a, [u, v]) => a + Math.abs(u - v), 0) / pairs.length;
  if (!best || mae < best.mae) best = { shift: s, mae, pairs };
}
const agree = best.pairs.filter(([u, v]) => (u > 0.5) === (v > 0.5)).length / best.pairs.length;
const speech = best.pairs.filter(([u]) => u > 0.5).length / best.pairs.length;
console.log(JSON.stringify({
  sileroFrames: ours.length,
  sileroMsPerFrame: +inferMs.toFixed(2),
  shift: +best.shift.toFixed(3),
  meanAbsDiff: +best.mae.toFixed(3),
  agreeOnSpeech: +(agree * 100).toFixed(1),
  speechShareDecoded: +(speech * 100).toFixed(1),
}));
