// Look-ahead, on YouTube: can a script in the page's world see the audio
// the player hands to Media Source Extensions, in what format, and how far
// ahead of playback? Hooks MediaSource.addSourceBuffer and
// SourceBuffer.appendBuffer before the page's scripts run, plays a video
// for a while into a null sink, and reports the source buffers, the
// appends and the audio buffered ahead. Saves the first audio appends to
// results/<browser>-audio-<n>.bin for the decoding test.
//
// A consent page is answered with "Reject all". A bot check stops the run.
//
// Usage: node spikes/lookahead/probe-youtube.mjs chrome|firefox [--video ID] [--sec 20] [--seek T] [--nohook]
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { nullSink, SINK, sleep } from '../../eval/lib/harness.mjs';

const puppeteer = createRequire(new URL('../../eval/package.json', import.meta.url))('puppeteer');
const [browserName, ...rest] = process.argv.slice(2);
const opt = (k, d) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : d;
};
const videoId = opt('--video', 'BFG1Q7zpNtE');
const sec = +opt('--sec', 20);
const seek = opt('--seek', null);
const noHook = rest.includes('--nohook');
const OUT = join(import.meta.dirname, 'results');
const KEEP_APPENDS = 4;

// Runs in the page's world before its scripts
function hook(keep) {
  const log = {
    workerMse: typeof MediaSource !== 'undefined' && !!MediaSource.canConstructInDedicatedWorker,
    managed: typeof ManagedMediaSource !== 'undefined',
    sources: 0,
    buffers: [],
    appends: [],
  };
  window.__la = log;
  window.__laBuffers = [];
  window.__laBytes = [];
  const seen = new WeakSet();
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    if (!seen.has(this)) {
      seen.add(this);
      log.sources++;
    }
    const sb = addSourceBuffer.call(this, mime);
    sb.__laId = log.buffers.length;
    log.buffers.push({ mime, at: performance.now() });
    window.__laBuffers.push(sb);
    return sb;
  };
  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const id = this.__laId;
    const mime = log.buffers[id]?.mime ?? '?';
    log.appends.push({ id, n: bytes.byteLength, at: performance.now(), offset: this.timestampOffset });
    if (/^audio/.test(mime) && window.__laBytes.length < keep) window.__laBytes.push(bytes.slice());
    return appendBuffer.call(this, data);
  };
}

const unload = nullSink();
const env = { ...process.env, PULSE_SINK: SINK };
const browser = browserName === 'chrome'
  ? await puppeteer.launch({ browser: 'chrome', headless: true, pipe: true, ignoreDefaultArgs: ['--mute-audio'], args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1280,900'], env })
  : await puppeteer.launch({ browser: 'firefox', executablePath: '/usr/bin/firefox', headless: true, extraPrefsFirefox: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 }, args: ['--width=1280', '--height=900'], env });
const out = { browser: browserName, version: await browser.version(), videoId };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  if (!noHook) await page.evaluateOnNewDocument(hook, KEEP_APPENDS);
  await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded' });
  const rejected = await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^\s*reject all\s*$/i.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  }, { timeout: 15000, polling: 500 }).then(() => true).catch(() => false);
  out.consentRejected = rejected;
  if (rejected) await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  if (await page.evaluate(() => /confirm you.re not a bot/i.test(document.body?.innerText ?? ''))) throw new Error('YouTube asked for a bot check; stopping');

  const VIDEO = '#movie_player video';
  await page.waitForFunction((sel) => document.querySelector(sel)?.readyState >= 2, { timeout: 30000 }, VIDEO);
  await page.evaluate((sel) => document.querySelector(sel).play().catch(() => {}), VIDEO);
  await page.waitForFunction((sel) => document.querySelector(sel).currentTime > 1, { timeout: 30000 }, VIDEO);

  // Every second: the video position and how far each source buffer
  // reaches beyond it
  out.samples = [];
  for (let s = 0; s < sec; s++) {
    if (seek && s === Math.floor(sec / 2)) await page.evaluate((t) => document.querySelector('#movie_player').seekTo(t, true), +seek);
    out.samples.push(await page.evaluate((sel) => {
      const v = document.querySelector(sel);
      const ahead = (window.__laBuffers ?? []).map((sb) => {
        try {
          const r = sb.buffered;
          for (let i = 0; i < r.length; i++) if (r.start(i) <= v.currentTime + 0.1 && r.end(i) > v.currentTime) return +(r.end(i) - v.currentTime).toFixed(1);
          return 0;
        } catch {
          return null;   // removed from its MediaSource
        }
      });
      return { t: +v.currentTime.toFixed(1), paused: v.paused, ready: v.readyState, rate: v.playbackRate, ad: !!document.querySelector('.ad-showing'), src: v.currentSrc.slice(0, 5), ahead };
    }, VIDEO));
    await sleep(1000);
  }
  const log = await page.evaluate(() => window.__la ?? { appends: [], buffers: [] });
  out.workerMse = log.workerMse;
  out.managedMediaSource = log.managed;
  out.mediaSources = log.sources;
  out.buffers = log.buffers.map((b, id) => {
    const a = log.appends.filter((x) => x.id === id);
    return { mime: b.mime, appends: a.length, bytes: a.reduce((s, x) => s + x.n, 0), offsets: [...new Set(a.map((x) => x.offset))] };
  });
  // The kept audio appends, as base64 to get them out of the page
  const kept = await page.evaluate(() => (window.__laBytes ?? []).map((b) => {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }));
  mkdirSync(OUT, { recursive: true });
  out.saved = kept.map((b64, i) => {
    const file = join(OUT, `${browserName}-audio-${i}.bin`);
    writeFileSync(file, Buffer.from(b64, 'base64'));
    return { file: `results/${browserName}-audio-${i}.bin`, bytes: Buffer.from(b64, 'base64').length };
  });
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String(e);
} finally {
  await browser.close();
  unload();
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `probe-${browserName}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
