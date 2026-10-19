// Look-ahead elsewhere: what a site's player hands to Media Source
// Extensions. The same hooks as probe-youtube.mjs, on any page: plays the
// largest video into a null sink and reports the MediaSources, their
// SourceBuffers (MIME types, appends, bytes) and how far each reaches
// beyond the playing position. --twitch-live opens the first live channel
// in Twitch's directory. A cookie banner is answered with its reject or
// necessary-only button, if it has one.
//
// Usage: node spikes/lookahead/probe-site.mjs chrome|firefox <url> [--sec 20]
//        node spikes/lookahead/probe-site.mjs chrome|firefox --twitch-live
import { createRequire } from 'node:module';
import { nullSink, SINK, sleep } from '../../eval/lib/harness.mjs';

const puppeteer = createRequire(new URL('../../eval/package.json', import.meta.url))('puppeteer');
const [browserName, ...rest] = process.argv.slice(2);
const sec = rest.includes('--sec') ? +rest[rest.indexOf('--sec') + 1] : 20;
let url = rest.find((x) => /^https?:/.test(x));

function hook() {
  const log = { workerMse: typeof MediaSource !== 'undefined' && !!MediaSource.canConstructInDedicatedWorker, sources: 0, buffers: [] };
  window.__la = log;
  window.__laBuffers = [];
  const seen = new WeakSet();
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    if (!seen.has(this)) {
      seen.add(this);
      log.sources++;
    }
    const sb = addSourceBuffer.call(this, mime);
    sb.__laId = log.buffers.length;
    log.buffers.push({ mime, appends: 0, bytes: 0 });
    window.__laBuffers.push(sb);
    return sb;
  };
  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const b = log.buffers[this.__laId];
    if (b) {
      b.appends++;
      b.bytes += data.byteLength;
    }
    return appendBuffer.call(this, data);
  };
}

const unload = nullSink();
const env = { ...process.env, PULSE_SINK: SINK };
const browser = browserName === 'chrome'
  ? await puppeteer.launch({ browser: 'chrome', headless: true, pipe: true, ignoreDefaultArgs: ['--mute-audio'], args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1280,900'], env })
  : await puppeteer.launch({ browser: 'firefox', executablePath: '/usr/bin/firefox', headless: true, extraPrefsFirefox: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 }, args: ['--width=1280', '--height=900'], env });
const out = { browser: browserName };
const rejectCookies = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^\s*(reject( all)?|decline|necessary only|only necessary)\s*$/i.test(x.textContent));
  b?.click();
  return !!b;
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  if (rest.includes('--twitch-live')) {
    await page.goto('https://www.twitch.tv/directory/all', { waitUntil: 'domcontentloaded' });
    await sleep(4000);
    out.cookies = await rejectCookies(page);
    url = await page.waitForFunction(() => document.querySelector('a[data-a-target="preview-card-image-link"]')?.href, { timeout: 30000 }).then((h) => h.jsonValue());
  }
  out.url = url;
  await page.evaluateOnNewDocument(hook);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  out.cookies = (await rejectCookies(page)) || out.cookies;
  // Twitch asks before mature streams
  await page.evaluate(() => document.querySelector('[data-a-target="content-classification-gate-overlay-start-watching-button"]')?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.readyState >= 2), { timeout: 30000 });
  await page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    v.muted = false;
    return v.play().catch(() => {});
  });
  await sleep(sec * 1000);
  Object.assign(out, await page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    const ahead = (window.__laBuffers ?? []).map((sb) => {
      try {
        const r = sb.buffered;
        for (let i = 0; i < r.length; i++) if (r.start(i) <= v.currentTime + 0.1 && r.end(i) > v.currentTime) return +(r.end(i) - v.currentTime).toFixed(1);
        return 0;
      } catch {
        return null;
      }
    });
    return {
      video: { t: +v.currentTime.toFixed(1), paused: v.paused, muted: v.muted, src: v.currentSrc.slice(0, 30), srcObject: v.srcObject ? v.srcObject.constructor.name : null },
      ...window.__la,
      ahead,
    };
  }));
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String(e);
} finally {
  await browser.close();
  unload();
}
console.log(JSON.stringify(out, null, 1));
