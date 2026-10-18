// Records the test clips in a browser at fixed speeds, through the real
// extension (the evaluation build): the 16 kHz audio it analysed, the
// browser's probabilities and timings, frame by frame. The offline replay
// (run.mjs) then switches between the speeds' recordings as the controller
// would switch the speed.
//
// Usage: node record.mjs chrome|firefox [--clips a,b] [--speeds 1,2.5] [--jobs 3] [--csp strict]
// Writes recordings/<browser>/<clip>-<speed>x.json. Build first:
//   node ../scripts/build.mjs --eval
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIPS, SPEEDS } from './lib/clips.mjs';
import { EVAL, evalCmd, launch, nullSink, startServer, waitForEval } from './lib/harness.mjs';

const [browserName, ...rest] = process.argv.slice(2);
if (!['chrome', 'firefox'].includes(browserName)) throw new Error('usage: node record.mjs chrome|firefox [options]');
const opt = (k, d) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : d;
};
const clips = opt('--clips', null)?.split(',') ?? CLIPS.map((c) => c.name);
const speeds = opt('--speeds', null)?.split(',').map(Number) ?? SPEEDS;
const jobs = +opt('--jobs', 3);
const csp = opt('--csp', '');
const outDir = join(EVAL, 'recordings', browserName + (csp ? `-${csp}` : ''));
mkdirSync(outDir, { recursive: true });

const tasks = clips.flatMap((name) => speeds.map((speed) => ({ clip: CLIPS.find((c) => c.name === name), speed })));
const unload = nullSink();
const server = await startServer();

async function record(browser, { clip, speed }) {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}/pages/player.html?src=/${clip.file}${csp ? `&csp=${csp}` : ''}`, { waitUntil: 'load' });
    await waitForEval(page);
    // Both speeds the same: Grindskip analyses as usual but keeps the speed
    await evalCmd(page, 'settings', { enabled: true, talkSpeed: speed, playSpeed: speed });
    await evalCmd(page, 'recordStart');
    const t0 = Date.now();
    await page.evaluate((speed) => {
      const v = document.getElementById('v');
      v.playbackRate = speed;
      return v.play();
    }, speed);
    await page.waitForFunction(() => document.getElementById('v').ended, { timeout: (clip.sec / speed + 60) * 1000, polling: 500 });
    const status = await evalCmd(page, 'status');
    const rec = await evalCmd(page, 'recordStop', {}, 120000);
    rec.eval = { browser: browserName, clip: clip.name, speed, csp: csp || null, where: status.where, wallSec: (Date.now() - t0) / 1000 };
    const file = join(outDir, `${clip.name}-${speed}x.json`);
    writeFileSync(file, JSON.stringify(rec));
    const n = rec.frames.p.length;
    console.log(`${browserName} ${clip.name} ${speed}x: ${n} frames (${(n * 0.032 * speed).toFixed(1)} s of media), ${status.where}, `
      + `${rec.events.length} events -> ${file}`);
  } finally {
    await page.close();
  }
}

let next = 0;
let failed = 0;
async function worker() {
  const browser = await launch(browserName);
  try {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        await record(browser, task);
      } catch (e) {
        failed++;
        console.error(`${browserName} ${task.clip.name} ${task.speed}x FAILED: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
} finally {
  await server.close();
  unload();
}
if (failed) process.exitCode = 1;
