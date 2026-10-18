// Phase 0 spike content script: runs ONNX Runtime Web and Silero inside the
// content script (spike 1), times it (spike 3), and captures the page's
// video through the planned path (spike 2's browser half):
//
//   captureStream / mozCaptureStream -> AnalyserNode polled every 30 ms
//   -> 16 kHz resampler -> 512-sample frames -> Silero
//
// The test driver talks to it with DOM events, because it runs in the page's
// world: it dispatches `gs-cmd` with a JSON string, and every reply comes
// back as a `gs-out` event with a JSON string.
import * as ort from 'onnxruntime-web/wasm';
import { createSilero, FRAME } from '../lib/silero.js';
import { createResampler, createFramer } from '../lib/resample.js';

const ext = globalThis.browser?.runtime ?? globalThis.chrome.runtime;
const POLL_MS = 30;

function reply(id, body) {
  document.dispatchEvent(new CustomEvent('gs-out', { detail: JSON.stringify({ id, ...body }) }));
}

function errInfo(e) {
  return { name: e?.name, message: String(e?.message ?? e), stack: String(e?.stack ?? '').slice(0, 1500) };
}

// WebAssembly memory of the ORT instance, found by watching instantiate
let wasmMemory = null;
const realInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function (...args) {
  const result = await realInstantiate.apply(this, args);
  const instance = result.instance ?? result;
  const pools = [instance.exports, ...Object.values(args[1] ?? {})];
  for (const pool of pools) {
    for (const v of Object.values(pool ?? {})) if (v instanceof WebAssembly.Memory) wasmMemory = v;
  }
  return result;
};

let vadPromise = null;
let loadInfo = null;

// wasmLoad 'url': ORT fetches and compiles the wasm itself (streaming);
// 'binary': the content script fetches it and hands ORT the bytes
async function loadVad(model, wasmLoad = 'url') {
  const t0 = performance.now();
  const onnx = await fetch(ext.getURL(`models/${model}.onnx`)).then((r) => r.arrayBuffer());
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  let wasmBytes = null;
  if (wasmLoad === 'binary') {
    const wasm = await fetch(ext.getURL('ort-wasm-simd-threaded.wasm')).then((r) => r.arrayBuffer());
    wasmBytes = wasm.byteLength;
    // In Firefox the fetched buffers belong to the page's compartment, and
    // ORT's `instanceof Uint8Array` check rejects views on them, so copy them
    ort.env.wasm.wasmBinary = ownBytes(wasm);
  } else {
    ort.env.wasm.wasmPaths = { wasm: ext.getURL('ort-wasm-simd-threaded.wasm') };
  }
  const t1 = performance.now();
  const vad = await createSilero(ort, ownBytes(onnx));
  ort.env.wasm.wasmBinary = undefined;
  const t2 = performance.now();
  loadInfo = {
    model, wasmLoad, fetchMs: t1 - t0, initMs: t2 - t1,
    wasmBytes, modelBytes: onnx.byteLength,
    wasmMemoryBytes: wasmMemory?.buffer.byteLength ?? null,
  };
  return vad;
}

function ownBytes(buffer) {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(new Uint8Array(buffer));
  return bytes;
}

function getVad(model, wasmLoad) {
  vadPromise ??= loadVad(model, wasmLoad);
  return vadPromise;
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
}

// Spike 1 and 3: does the model run here, and how fast?
async function bench({ model, frames = 1500, wasmLoad }) {
  const vad = await getVad(model, wasmLoad);
  const frame = new Float32Array(FRAME);
  let seed = 1;
  const times = [];
  let batchStart = 0;
  for (let k = 0; k < frames; k++) {
    if (k === 50) batchStart = performance.now();
    for (let i = 0; i < FRAME; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      frame[i] = 0.3 * Math.sin(2 * Math.PI * 220 * (k * FRAME + i) / 16000) + 0.05 * (seed / 0x7fffffff - 0.5);
    }
    const t = performance.now();
    await vad.process(frame);
    times.push(performance.now() - t);
  }
  // Timers are coarse outside cross-origin isolation (0.1 ms in Chrome,
  // 1 ms in Firefox), so the whole batch is timed too
  const batchMsPerFrame = (performance.now() - batchStart) / (frames - 50);
  vad.reset();
  return {
    load: { ...loadInfo, wasmMemoryBytes: wasmMemory?.buffer.byteLength ?? null },
    perFrameMs: stats(times.slice(50)),
    batchMsPerFrame,
    env: envInfo(),
  };
}

function envInfo() {
  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    captureStream: typeof HTMLMediaElement.prototype.captureStream,
    mozCaptureStream: typeof HTMLMediaElement.prototype.mozCaptureStream,
  };
}

function largestVideo() {
  let best = null;
  let bestArea = -1;
  for (const v of document.querySelectorAll('video')) {
    const area = v.clientWidth * v.clientHeight;
    if (area > bestArea) { best = v; bestArea = area; }
  }
  return best;
}

// Spike 2 (browser half) and pipeline cost: capture the video's audio,
// run Silero on it and keep the trace, the 16 kHz audio and the timings.
let cap = null;

async function captureStart({ model, keepPcm = true, connectToOutput = false, wasmLoad }) {
  if (cap) throw new Error('capture already running');
  const vad = await getVad(model, wasmLoad);
  vad.reset();
  const video = largestVideo();
  if (!video) throw new Error('no video');
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const method = typeof video.captureStream === 'function' ? 'captureStream' : 'mozCaptureStream';
  const stream = video[method]();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 32768;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  if (connectToOutput) source.connect(ctx.destination);

  cap = {
    video, ctx, stream, source, analyser, vad, method,
    buf: new Float32Array(analyser.fftSize),
    resampler: createResampler(ctx.sampleRate),
    framer: createFramer(FRAME),
    lastCtxTime: ctx.currentTime,
    inSamples: 0,        // input samples analysed so far
    polls: [],           // { wall, ctxTime, currentTime, rate, n, cum, paused }
    frames: [],          // { p, cum (input samples at frame end), wall }
    pcm: keepPcm ? [] : null,
    pollBusyMs: [],      // synchronous part of each poll
    inferMs: [],
    queue: Promise.resolve(),
    overflow: 0,
  };
  cap.timer = setInterval(poll, POLL_MS);
  return { sampleRate: ctx.sampleRate, method, tracks: stream.getAudioTracks().length, baseLatency: ctx.baseLatency ?? null, outputLatency: ctx.outputLatency ?? null };
}

function poll() {
  const c = cap;
  const t0 = performance.now();
  const ctxTime = c.ctx.currentTime;
  let n = Math.round((ctxTime - c.lastCtxTime) * c.ctx.sampleRate);
  c.lastCtxTime = ctxTime;
  if (n > c.buf.length) { c.overflow++; n = c.buf.length; }
  const v = c.video;
  const paused = v.paused || v.seeking || v.readyState < 3;
  c.analyser.getFloatTimeDomainData(c.buf);
  const fresh = c.buf.subarray(c.buf.length - n);
  c.inSamples += n;
  c.polls.push({ wall: t0, ctxTime, currentTime: v.currentTime, rate: v.playbackRate, n, cum: c.inSamples, paused });
  const out = c.resampler.push(fresh);
  const cum = c.inSamples;
  const pending = [];
  c.framer.push(out, (f) => pending.push(f.slice()));
  if (c.pcm) c.pcm.push(Float32Array.from(out));
  c.pollBusyMs.push(performance.now() - t0);
  for (const f of pending) {
    c.queue = c.queue.then(async () => {
      const t = performance.now();
      const p = await c.vad.process(f);
      c.inferMs.push(performance.now() - t);
      c.frames.push({ p, cum, wall: t });
    });
  }
}

async function captureStop() {
  const c = cap;
  if (!c) throw new Error('no capture running');
  clearInterval(c.timer);
  await c.queue;
  cap = null;
  try { c.source.disconnect(); } catch {}
  await c.ctx.close();
  let pcm16 = null;
  if (c.pcm) {
    const total = c.pcm.reduce((s, a) => s + a.length, 0);
    const i16 = new Int16Array(total);
    let o = 0;
    for (const a of c.pcm) for (let i = 0; i < a.length; i++) i16[o++] = Math.max(-32768, Math.min(32767, Math.round(a[i] * 32767)));
    pcm16 = toBase64(new Uint8Array(i16.buffer));
  }
  const wallSec = (c.polls.at(-1).wall - c.polls[0].wall) / 1000;
  const busy = c.pollBusyMs.reduce((a, b) => a + b, 0) + c.inferMs.reduce((a, b) => a + b, 0);
  return {
    method: c.method,
    sampleRate: c.ctx.sampleRate,
    polls: c.polls,
    frames: c.frames,
    pcm16,
    overflow: c.overflow,
    cost: {
      wallSec,
      busyMsPerSec: busy / wallSec,
      pollMs: stats(c.pollBusyMs),
      inferMs: stats(c.inferMs),
      pollIntervalMs: stats(c.polls.slice(1).map((p, i) => p.wall - c.polls[i].wall)),
    },
    load: { ...loadInfo, wasmMemoryBytes: wasmMemory?.buffer.byteLength ?? null },
  };
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Spike 1 fallback: the same model behind a runtime.Port in an extension
// context; measures the round trip per frame
async function benchRemote({ target = 'bg', frames = 300 }) {
  if (target === 'offscreen') {
    const r = await ext.sendMessage({ type: 'ensureOffscreen' });
    if (!r?.ok) throw new Error(`offscreen: ${r?.error}`);
  }
  const port = ext.connect({ name: target === 'offscreen' ? 'vad-offscreen' : 'vad-bg' });
  const pending = new Map();
  let nextId = 0;
  port.onMessage.addListener((m) => { pending.get(m.id)?.(m); pending.delete(m.id); });
  const ask = (msg) => new Promise((ok, fail) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? fail(new Error(m.error)) : ok(m)));
    port.postMessage({ id, ...msg });
  });
  try {
    const hello = await ask({ hello: true });
    const frame = new Float32Array(FRAME);
    const rtt = [];
    const infer = [];
    const batchStart = performance.now();
    for (let k = 0; k < frames; k++) {
      for (let i = 0; i < FRAME; i++) frame[i] = 0.3 * Math.sin(2 * Math.PI * 220 * (k * FRAME + i) / 16000);
      const t = performance.now();
      const r = await ask({ frame: Array.from(frame) });
      rtt.push(performance.now() - t);
      infer.push(r.inferMs);
    }
    return { target, hello, rttMs: stats(rtt), remoteInferMs: stats(infer), batchMsPerFrame: (performance.now() - batchStart) / frames };
  } finally {
    port.disconnect();
  }
}

// Lifetime check for the fallback: streams a frame every 32 ms for
// `sec` seconds, like a long video would, reconnecting if the extension
// context goes away (a stopped service worker or suspended event page)
function soakRemote({ target = 'bg', sec = 360 }) {
  return new Promise((done) => {
    const frame = Array.from({ length: FRAME }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 220 * i / 16000));
    const res = { target, sent: 0, replies: 0, errors: 0, disconnects: [], maxReplyGapMs: 0, lastError: null };
    const t0 = performance.now();
    let lastReply = t0;
    let port = null;
    const connect = () => {
      port = ext.connect({ name: target === 'offscreen' ? 'vad-offscreen' : 'vad-bg' });
      port.onMessage.addListener((m) => {
        if (m.error) { res.errors++; res.lastError = m.error; return; }
        const now = performance.now();
        res.maxReplyGapMs = Math.max(res.maxReplyGapMs, now - lastReply);
        lastReply = now;
        res.replies++;
      });
      port.onDisconnect.addListener(() => {
        res.disconnects.push(Math.round((performance.now() - t0) / 1000));
        port = null;
      });
    };
    connect();
    const timer = setInterval(() => {
      if (performance.now() - t0 > sec * 1000) {
        clearInterval(timer);
        port?.disconnect();
        res.wallSec = (performance.now() - t0) / 1000;
        done(res);
        return;
      }
      if (!port) connect();
      try { port.postMessage({ id: res.sent, frame }); res.sent++; } catch (e) { res.errors++; res.lastError = String(e); port = null; }
    }, 32);
  });
}

const handlers = {
  ping: async () => ({ env: envInfo(), href: location.href }),
  benchRemote,
  soakRemote,
  bench,
  captureStart,
  captureStop,
};

document.addEventListener('gs-cmd', async (e) => {
  let msg;
  try { msg = JSON.parse(e.detail); } catch { return; }
  try {
    reply(msg.id, { ok: true, result: await handlers[msg.cmd](msg.args ?? {}) });
  } catch (err) {
    reply(msg.id, { ok: false, error: errInfo(err) });
  }
});
document.documentElement.dataset.gsSpike = 'ready';
