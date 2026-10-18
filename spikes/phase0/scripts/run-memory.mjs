// Spike 3, memory: the browser's total PSS (proportional set size, summed
// over its process tree) on the player page, before and after the content
// script loads ONNX Runtime and Silero and runs it. This includes the
// compiled WebAssembly code, which the wasm heap size alone leaves out.
//
// Measured in stages with the video paused, since playback alone moves
// Firefox's memory by more than 100 MB: the page alone, after loading and
// running the model (bench), then after a capture of the paused video
// (AudioContext + AnalyserNode + polling). Each stage waits 10 s and
// is measured three times.
//
// Usage: node scripts/run-memory.mjs chrome|firefox [--ext dir] [--wasm-load url|binary]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { launch, startServer, nullSink, cmd, waitForSpike, sleep } from '../lib/harness.mjs';

const [browserName, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const wasmLoad = opt('--wasm-load', 'url');

function tree(root) {
  const kids = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(+d);
    } catch {}
  }
  const out = [];
  const walk = (p) => { out.push(p); for (const k of kids.get(p) ?? []) walk(k); };
  walk(root);
  return out;
}

function pssKb(pids) {
  let total = 0;
  const per = [];
  for (const pid of pids) {
    try {
      const m = /Pss:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const kb = m ? +m[1] : 0;
      total += kb;
      per.push({ pid, kb, type: (cmd.find((a) => a.startsWith('--type=')) ?? cmd.slice(-1)[0] ?? '').slice(0, 40) });
    } catch {}
  }
  return { total, per: per.sort((a, b) => b.kb - a.kb).slice(0, 4) };
}

const unload = nullSink();
const server = await startServer();
const { browser } = await launch(browserName, { extension: opt('--ext', 'build') });
try {
  const root = browser.process().pid;
  const page = await browser.newPage();
  await page.goto(`${server.url}/pages/player.html?src=/media/bumpy_0-120.webm`, { waitUntil: 'load' });
  await waitForSpike(page);
  await page.waitForFunction(() => document.getElementById('v').readyState >= 2);
  const measure = async () => {
    const xs = [];
    for (let i = 0; i < 3; i++) { await sleep(3000); xs.push(pssKb(tree(root)).total / 1024); }
    return xs.sort((a, b) => a - b)[1];
  };
  await sleep(5000);
  const page0 = await measure();
  const bench = await cmd(page, 'bench', { model: 'silero_vad_v6.2_16k', frames: 500, wasmLoad }, 120000);
  const withModel = await measure();
  await cmd(page, 'captureStart', { model: 'silero_vad_v6.2_16k', keepPcm: false });
  const withCapture = await measure();
  await cmd(page, 'captureStop');
  const res = {
    browser: browserName, wasmLoad,
    pageMB: +page0.toFixed(1),
    modelLoadedMB: +(withModel - page0).toFixed(1),
    captureMB: +(withCapture - withModel).toFixed(1),
    wasmHeapMB: bench.load.wasmMemoryBytes ? +(bench.load.wasmMemoryBytes / 1e6).toFixed(1) : null,
    initMs: Math.round(bench.load.initMs),
    final: pssKb(tree(root)).per,
  };
  console.log(JSON.stringify(res, null, 1));
  writeFileSync(`results/memory-${browserName}-${wasmLoad}.json`, JSON.stringify(res, null, 1));
} finally {
  await browser.close();
  await server.close();
  unload();
}
