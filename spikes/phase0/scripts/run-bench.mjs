// Spikes 1 and 3: does ONNX Runtime Web + Silero run in the content script,
// and what does a frame cost? Runs on the local player page, or on any URL.
//
// With --csp strict the local page is served with STRICT_CSP (no eval, no
// 'wasm-unsafe-eval', Trusted Types required), and a short capture of the
// playing video is run after the bench.
//
// Usage: node scripts/run-bench.mjs chrome|firefox [--url URL] [--ext build|build-nocsp]
//        [--model name] [--frames N] [--csp strict] [--wasm-load url|binary]
//        [--remote bg|offscreen]   run the model in an extension context instead
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, startServer, nullSink, cmd, waitForSpike, sleep } from '../lib/harness.mjs';

const [browserName, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const ext = opt('--ext', 'build');
const model = opt('--model', 'silero_vad_v6.2_16k');
const frames = +opt('--frames', 1500);
const cspMode = opt('--csp', '');
const strict = cspMode.startsWith('strict');
const wasmLoad = opt('--wasm-load', 'url');
const remote = opt('--remote', null);

const unload = nullSink();
const server = await startServer();
const { browser } = await launch(browserName, { extension: ext });
try {
  const page = await browser.newPage();
  const url = opt('--url', `${server.url}/pages/player.html?src=/media/bumpy_0-120.webm${strict ? `&csp=${cspMode}` : ''}`);
  await page.goto(url, { waitUntil: 'load' });
  await waitForSpike(page);
  const ping = await cmd(page, 'ping');
  console.log('ping:', JSON.stringify(ping.env));
  let result;
  if (remote) {
    try {
      result = { ok: true, ...(await cmd(page, 'benchRemote', { target: remote, frames }, 300000)) };
      console.log(`remote ${remote}: init ${result.hello.initMs.toFixed(0)} ms; round trip mean ${result.rttMs.mean.toFixed(3)} p50 ${result.rttMs.p50.toFixed(2)} `
        + `p95 ${result.rttMs.p95.toFixed(2)} p99 ${result.rttMs.p99.toFixed(2)} max ${result.rttMs.max.toFixed(1)} ms; remote inference ${result.remoteInferMs.mean.toFixed(3)} ms`);
    } catch (e) {
      result = { ok: false, error: e.info ?? String(e) };
      console.log('remote FAILED:', JSON.stringify(result.error, null, 1));
    }
  } else try {
    result = { ok: true, ...(await cmd(page, 'bench', { model, frames, wasmLoad }, 300000)) };
    const f = result.perFrameMs;
    console.log(`bench ${model}: batch ${result.batchMsPerFrame.toFixed(3)} ms/frame, fetch ${result.load.fetchMs.toFixed(0)} ms, init ${result.load.initMs.toFixed(0)} ms, `
      + `wasm memory ${(result.load.wasmMemoryBytes / 1e6).toFixed(1)} MB; per frame mean ${f.mean.toFixed(3)} p50 ${f.p50.toFixed(3)} `
      + `p95 ${f.p95.toFixed(3)} p99 ${f.p99.toFixed(3)} max ${f.max.toFixed(2)} ms -> ${(f.mean / 32 * 100).toFixed(2)}% of one core`);
    if (strict) {
      const csp = await page.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'));
      await page.evaluate(() => document.getElementById('v').play());
      await cmd(page, 'captureStart', { model, keepPcm: false });
      await sleep(5000);
      const r = await cmd(page, 'captureStop');
      result.strictCapture = { csp, frames: r.frames.length, speechShare: r.frames.filter((f) => f.p > 0.5).length / r.frames.length };
      console.log('strict CSP capture:', JSON.stringify(result.strictCapture));
    }
  } catch (e) {
    result = { ok: false, error: e.info ?? String(e) };
    console.log('bench FAILED:', JSON.stringify(result.error, null, 1));
  }
  mkdirSync('results', { recursive: true });
  const tag = `${browserName}-${ext}-${strict ? `${cspMode}-csp` : new URL(url).hostname.replace(/\W/g, '_')}${remote ? `-remote-${remote}` : ''}`;
  writeFileSync(`results/bench-${tag}.json`, JSON.stringify({ url, ping, ...result }, null, 1));
  console.log(`wrote results/bench-${tag}.json`);
} finally {
  await browser.close();
  await server.close();
  unload();
}
