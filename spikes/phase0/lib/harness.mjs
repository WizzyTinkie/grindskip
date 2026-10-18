// Shared plumbing for the browser spikes: a local static server, a
// temporary PipeWire/PulseAudio null sink so nothing plays through the
// speakers, and Puppeteer launchers for Chrome for Testing and Firefox with
// the spike extension installed.
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { extname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
// One sink per process, so parallel runs don't unload each other's sink
export const SINK = `grindskip_spike_${process.pid}`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.json': 'application/json' };

// A page CSP stricter than YouTube's: no eval, no 'wasm-unsafe-eval', and
// Trusted Types required
export const STRICT_CSP = "default-src 'self'; script-src 'self'; object-src 'none'; media-src 'self' blob:; require-trusted-types-for 'script'";

// Static files from ROOT with Range support (media elements need it to
// seek). Pages requested with ?csp=strict get STRICT_CSP; ?csp=strict-wasm
// gets it with 'wasm-unsafe-eval' allowed, as a control.
export function startServer(port = 0) {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://x');
    const path = join(ROOT, decodeURIComponent(reqUrl.pathname));
    const csp = reqUrl.searchParams.get('csp');
    if (csp === 'strict') res.setHeader('Content-Security-Policy', STRICT_CSP);
    if (csp === 'strict-wasm') res.setHeader('Content-Security-Policy', STRICT_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'"));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let st;
    try { st = statSync(path); } catch { res.writeHead(404).end(); return; }
    if (!st.isFile()) { res.writeHead(404).end(); return; }
    const type = TYPES[extname(path)] ?? 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (m) {
      const start = m[1] ? +m[1] : 0;
      const end = m[2] ? +m[2] : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
      createReadStream(path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
      createReadStream(path).pipe(res);
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

// Loads a null sink for this process and unloads it on exit. Returns the
// unload function. The browsers are pointed at it with PULSE_SINK.
export function nullSink() {
  const id = execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${SINK}`,
    'sink_properties=device.description=GrindskipSpike', 'rate=48000', 'channels=2']).toString().trim();
  let loaded = true;
  const unload = () => {
    if (!loaded) return;
    loaded = false;
    try { execFileSync('pactl', ['unload-module', id]); } catch {}
  };
  process.on('exit', unload);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { unload(); process.exit(130); });
  return unload;
}

// Records the null sink's monitor (48 kHz stereo s16le) until stop() is
// called; stop() resolves to { samples: Float32Array (mono), startedAt }.
export function recordSink() {
  const startedAt = Date.now();
  const proc = spawn('parecord', ['-d', `${SINK}.monitor`, '--raw', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=20']);
  const chunks = [];
  proc.stdout.on('data', (c) => chunks.push(c));
  return {
    startedAt,
    stop: () => new Promise((ok) => {
      proc.on('close', () => {
        const b = Buffer.concat(chunks);
        const i16 = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4) * 2);
        const mono = new Float32Array(i16.length / 2);
        for (let i = 0; i < mono.length; i++) mono[i] = (i16[2 * i] + i16[2 * i + 1]) / 65536;
        ok({ samples: mono, startedAt });
      });
      proc.kill('SIGINT');
    }),
  };
}

// DevTools keeps an attached service worker alive, so Puppeteer is kept off
// the extension's service worker and offscreen document
export async function launch(browserName, { extension = 'build', headless = true } = {}) {
  const env = { ...process.env, PULSE_SINK: SINK };
  let browser;
  if (browserName === 'chrome') {
    browser = await puppeteer.launch({
      browser: 'chrome',
      headless,
      pipe: true,
      enableExtensions: true,
      ignoreDefaultArgs: ['--mute-audio'],
      args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1280,900'],
      protocolTimeout: 15 * 60 * 1000,
      targetFilter: (t) => !t.url().startsWith('chrome-extension://') || t.type() === 'page',
      env,
    });
  } else {
    browser = await puppeteer.launch({
      browser: 'firefox',
      executablePath: '/usr/bin/firefox',
      headless,
      protocolTimeout: 15 * 60 * 1000,
      extraPrefsFirefox: {
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.block-autoplay-until-in-foreground': false,
      },
      args: ['--width=1280', '--height=900'],
      env,
    });
  }
  let extensionId = null;
  if (extension) extensionId = await browser.installExtension(join(ROOT, extension, browserName));
  return { browser, extensionId };
}

// Sends a command to the spike content script and waits for its reply.
export async function cmd(page, name, args = {}, timeoutMs = 120000) {
  const raw = await page.evaluate((name, argsJson, timeoutMs) => new Promise((ok, fail) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => fail(new Error(`timeout waiting for ${name}`)), timeoutMs);
    document.addEventListener('gs-out', function on(e) {
      const msg = JSON.parse(e.detail);
      if (msg.id !== id) return;
      document.removeEventListener('gs-out', on);
      clearTimeout(timer);
      ok(e.detail);
    });
    document.dispatchEvent(new CustomEvent('gs-cmd', { detail: JSON.stringify({ id, cmd: name, args: JSON.parse(argsJson) }) }));
  }), name, JSON.stringify(args), timeoutMs);
  const msg = JSON.parse(raw);
  if (!msg.ok) {
    const err = new Error(`${name} failed: ${msg.error.name}: ${msg.error.message}`);
    err.info = msg.error;
    throw err;
  }
  return msg.result;
}

export async function waitForSpike(page, timeoutMs = 20000) {
  await page.waitForFunction(() => document.documentElement.dataset.gsSpike === 'ready', { timeout: timeoutMs });
}

export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
