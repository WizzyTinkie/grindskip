// Spike 1 on the real target: ONNX Runtime Web + Silero in the content
// script on a YouTube watch page, under YouTube's CSP and Trusted Types.
// Runs the bench, then captures the playing video for a while through the
// planned path and reports the probabilities and the cost.
//
// A consent page is answered with "Reject all". A bot check stops the run.
//
// Usage: node scripts/run-youtube.mjs chrome|firefox [--video ID] [--sec N] [--ext build|build-nocsp] [--headful]
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, nullSink, cmd, waitForSpike, sleep } from '../lib/harness.mjs';

const [browserName, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const videoId = opt('--video', '4ThQDMlPWM0');
const sec = +opt('--sec', 20);
const ext = opt('--ext', 'build');
const model = 'silero_vad_v6.2_16k';

const unload = nullSink();
const { browser } = await launch(browserName, { extension: ext, headless: !rest.includes('--headful') });
const out = { browser: browserName, ext, videoId, steps: [] };
const step = (name, data) => { out.steps.push({ name, ...data }); console.log(name, JSON.stringify(data).slice(0, 400)); };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const resp = await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded' });
  step('loaded', { url: page.url(), status: resp?.status() });

  // The consent dialog (in-page in the EU, or a consent.youtube.com
  // redirect) can take a few seconds to appear
  const clicked = await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^\s*reject all\s*$/i.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  }, { timeout: 15000, polling: 500 }).then(() => true).catch(() => false);
  step('consent', { rejectedAll: clicked });
  if (clicked) await sleep(3000);
  if (/consent\./.test(page.url())) await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

  // The CSP and Trusted Types headers the content script lives under
  const headers = await page.evaluate(async () => {
    const r = await fetch(location.href, { credentials: 'include' });
    return { csp: r.headers.get('content-security-policy'), cspRO: r.headers.get('content-security-policy-report-only') };
  }).catch((e) => ({ error: String(e) }));
  step('headers', headers);

  const botCheck = await page.evaluate(() => /confirm you.re not a bot/i.test(document.body?.innerText ?? ''));
  if (botCheck) { step('bot-check', { stopped: true }); throw new Error('YouTube asked for a bot check; stopping'); }

  await waitForSpike(page, 30000);
  step('ping', await cmd(page, 'ping'));

  // The main player's video, not a hover preview
  const VIDEO = '#movie_player video';
  await page.waitForFunction((sel) => { const v = document.querySelector(sel); return v && v.readyState >= 2; }, { timeout: 30000 }, VIDEO);
  await page.evaluate((sel) => document.querySelector(sel).play().catch(() => {}), VIDEO);
  await page.waitForFunction((sel) => { const v = document.querySelector(sel); return v && !v.paused && v.currentTime > 1; }, { timeout: 30000 }, VIDEO);
  step('playing', await page.evaluate((sel) => {
    const v = document.querySelector(sel);
    return { currentTime: v.currentTime, duration: v.duration, ad: !!document.querySelector('.ad-showing'), src: v.currentSrc.slice(0, 40) };
  }, VIDEO));

  try {
    const b = await cmd(page, 'bench', { model, frames: 1500 }, 300000);
    step('bench', { ok: true, load: b.load, perFrameMs: b.perFrameMs, batchMsPerFrame: b.batchMsPerFrame });
  } catch (e) {
    step('bench', { ok: false, error: e.info ?? String(e) });
    throw e;
  }

  const start = await cmd(page, 'captureStart', { model, keepPcm: false });
  step('captureStart', start);
  await sleep(sec * 1000);
  const r = await cmd(page, 'captureStop');
  const probs = r.frames.map((f) => f.p);
  const above = probs.filter((p) => p > 0.5).length;
  step('capture', {
    method: r.method, sampleRate: r.sampleRate, frames: probs.length, overflow: r.overflow,
    speechShare: above / probs.length, meanProb: probs.reduce((a, b) => a + b, 0) / probs.length,
    cost: r.cost,
    playing: await page.evaluate((sel) => { const v = document.querySelector(sel); return { currentTime: v.currentTime, paused: v.paused, ad: !!document.querySelector('.ad-showing') }; }, VIDEO),
  });
  out.trace = probs.map((p) => Math.round(p * 1000) / 1000);
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String(e);
  console.log('FAILED:', e.message);
} finally {
  mkdirSync('results', { recursive: true });
  writeFileSync(`results/youtube-${browserName}-${ext}.json`, JSON.stringify(out, null, 1));
  console.log(`wrote results/youtube-${browserName}-${ext}.json`);
  await browser.close();
  unload();
}
