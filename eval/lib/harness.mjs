// Browser plumbing for the evaluation: a static server for pages/ and
// media/, a temporary PipeWire/PulseAudio null sink so nothing plays through
// the speakers, Puppeteer launchers for Chrome for Testing and Firefox with
// the evaluation build installed, and the channel to its content script
// (eval/ext/content.js).
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

export const EVAL = resolve(import.meta.dirname, '..');
// One sink per process, so parallel runs don't unload each other's
export const SINK = `grindskip_eval_${process.pid}`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.webm': 'video/webm' };
const STRICT_CSP = "default-src 'self'; script-src 'self'; object-src 'none'; media-src 'self' blob:; require-trusted-types-for 'script'";

// Static files from eval/ with Range support (media elements need it to
// seek). ?csp=strict serves a page with a CSP that blocks WebAssembly in
// Chrome's content scripts.
export function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = join(EVAL, decodeURIComponent(url.pathname));
    if (!path.startsWith(EVAL)) return res.writeHead(403).end();
    if (url.searchParams.get('csp') === 'strict') res.setHeader('Content-Security-Policy', STRICT_CSP);
    let st;
    try {
      st = statSync(path);
    } catch {
      return res.writeHead(404).end();
    }
    if (!st.isFile()) return res.writeHead(404).end();
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
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

// Loads a null sink for this process and unloads it on exit; returns the
// unload function. The browsers play into it through PULSE_SINK.
export function nullSink() {
  const id = execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${SINK}`,
    'sink_properties=device.description=GrindskipEval', 'rate=48000', 'channels=2']).toString().trim();
  let loaded = true;
  const unload = () => {
    if (!loaded) return;
    loaded = false;
    try {
      execFileSync('pactl', ['unload-module', id]);
    } catch { /* already gone */ }
  };
  process.on('exit', unload);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { unload(); process.exit(130); });
  return unload;
}

// A browser with the evaluation build (eval/build/<browser>) installed.
export async function launch(browserName) {
  const env = { ...process.env, PULSE_SINK: SINK };
  const browser = browserName === 'chrome'
    ? await puppeteer.launch({
      browser: 'chrome',
      headless: true,
      pipe: true,
      enableExtensions: true,
      ignoreDefaultArgs: ['--mute-audio'],
      args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1280,900'],
      protocolTimeout: 15 * 60 * 1000,
      // DevTools would keep the service worker and offscreen document alive
      targetFilter: (t) => !t.url().startsWith('chrome-extension://') || t.type() === 'page',
      env,
    })
    : await puppeteer.launch({
      browser: 'firefox',
      executablePath: '/usr/bin/firefox',
      headless: true,
      protocolTimeout: 15 * 60 * 1000,
      extraPrefsFirefox: {
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.block-autoplay-until-in-foreground': false,
      },
      args: ['--width=1280', '--height=900'],
      env,
    });
  await browser.installExtension(join(EVAL, 'build', browserName));
  return browser;
}

// Sends a command to the evaluation content script and returns its result.
export async function evalCmd(page, cmd, args = {}, timeoutMs = 60000) {
  const raw = await page.evaluate((cmd, argsJson, timeoutMs) => new Promise((ok, fail) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => fail(new Error(`timeout waiting for ${cmd}`)), timeoutMs);
    document.addEventListener('grindskip-eval-reply', function on(e) {
      if (JSON.parse(e.detail).id !== id) return;
      document.removeEventListener('grindskip-eval-reply', on);
      clearTimeout(timer);
      ok(e.detail);
    });
    document.dispatchEvent(new CustomEvent('grindskip-eval', { detail: JSON.stringify({ id, cmd, args: JSON.parse(argsJson) }) }));
  }), cmd, JSON.stringify(args), timeoutMs);
  const msg = JSON.parse(raw);
  if (!msg.ok) throw new Error(`${cmd}: ${msg.error}`);
  return msg.result;
}

export async function waitForEval(page) {
  await page.waitForFunction(() => document.documentElement.dataset.grindskipEval === 'ready', { timeout: 20000 });
}

export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
