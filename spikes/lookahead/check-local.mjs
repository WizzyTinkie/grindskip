// Look-ahead in the extension, end to end on a local page: plays an eval
// clip through Media Source Extensions (eval/pages/mse.html) with the
// evaluation build at 2.5x, samples the position and speed every 50 ms, and
// scores the run: the share of the caption-labelled speech played at talk
// speed, and for each speech onset the model hears at 1x, how long before
// it the video slowed down. --live plays
// the plain file instead (eval/pages/player.html), where Grindskip can only
// listen live, for comparison. --seek W:T seeks to media time T after W
// seconds of playing.
//
// Usage: node spikes/lookahead/check-local.mjs chrome|firefox [--clip mattg] [--live] [--seek 20:80] [--trace] [--csp-strict]
//   --csp-strict: a page whose CSP stops Chrome's content script compiling
//   WebAssembly, so the model runs in the offscreen document
import { readFileSync } from 'node:fs';
import { CLIPS } from '../../eval/lib/clips.mjs';
import { EVAL, evalCmd, launch, nullSink, sleep, startServer, waitForEval } from '../../eval/lib/harness.mjs';
import { labelsFor } from '../../eval/lib/labels.mjs';

const [browserName, ...rest] = process.argv.slice(2);
const opt = (k, d) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : d;
};
const clip = CLIPS.find((c) => c.name === opt('--clip', 'mattg'));
const live = rest.includes('--live');
const csp = rest.includes('--csp-strict') ? '&csp=strict' : '';
const [seekAfter, seekTo] = (opt('--seek', '') || ':').split(':').map((x) => (x === '' ? null : +x));
const PLAY = 2.5;

const unload = nullSink();
const server = await startServer();
const browser = await launch(browserName);
const samples = [];
const modes = new Set();
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/pages/${live ? 'player' : 'mse'}.html?src=/${clip.file}${csp}`, { waitUntil: 'load' });
  await waitForEval(page);
  await page.waitForFunction(() => document.getElementById('v').readyState >= 3, { timeout: 30000 });
  await evalCmd(page, 'settings', { enabled: true, talkSpeed: 1, playSpeed: PLAY });
  await page.evaluate(() => document.getElementById('v').play());
  const t0 = Date.now();
  let seeked = false;
  for (;;) {
    const s = await page.evaluate(() => {
      const v = document.getElementById('v');
      return { t: v.currentTime, rate: v.playbackRate, ended: v.ended || v.currentTime >= v.duration - 0.5 };
    });
    samples.push(s);
    if (samples.length % 20 === 0) {
      const st = await evalCmd(page, 'status');
      modes.add(`${st.mode} (${st.where})`);
      if (samples.length % 100 === 0) console.log(`t=${s.t.toFixed(1)} rate=${s.rate} mode=${st.mode} state=${st.state} ahead=${st.lookahead?.ahead} analysed=${st.lookahead?.analysed} decodedUntil=${st.lookahead?.decodedUntil?.toFixed(1)} counts=${JSON.stringify(st.lookahead?.counts)} error=${st.lookahead?.error} note=${st.note}`);
    }
    if (!seeked && seekAfter !== null && Date.now() - t0 > seekAfter * 1000) {
      seeked = true;
      await page.evaluate((t) => { document.getElementById('v').currentTime = t; }, seekTo);
      console.log(`-- seek to ${seekTo} s`);
      samples.push(null);
    }
    if (s.ended || Date.now() - t0 > 150000) break;
    await sleep(50);
  }
} finally {
  await browser.close();
  await server.close();
  unload();
}

// Media played at talk speed, from consecutive samples
const labels = labelsFor(clip, new URL(`file://${EVAL}/`));
const slow = [];
for (let i = 0; i + 1 < samples.length; i++) {
  const [a, b] = [samples[i], samples[i + 1]];
  if (!a || !b || b.t < a.t || b.t - a.t > 1) continue;
  if (a.rate < 1.1) slow.push([a.t, b.t]);
}
const overlap = (a, b) => slow.reduce((s, [x, y]) => s + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
const reached = (a, b) => samples.some((s) => s && s.t >= a && s.t < b);
let speech = 0;
let heard = 0;
for (const [a, b] of labels) {
  if (!reached(a, b)) continue;
  speech += b - a;
  heard += overlap(a, b);
}
// Speech onsets as the model hears them at 1x (the Phase 3 recording of
// the same clip in the same browser): the first frame of 8 or more in a
// row at 0.5 or above, after at least 1.5 s below it. Caption onsets are
// often off by a second (eval/REPORT.md).
const rec = JSON.parse(readFileSync(new URL(`file://${EVAL}/recordings/${browserName}/${clip.name}-1x.json`), 'utf8')).frames;
const one = rec.mediaTime.map((m, k) => [m, rec.p[k]]).filter(([m, p]) => m !== null && p !== null);
const onsets = [];
let quietSince = -Infinity;
for (let k = 0; k + 8 <= one.length; k++) {
  if (one[k][1] < 0.5) continue;
  if (one.slice(k, k + 8).every(([, p]) => p >= 0.5) && one[k][0] - 0.032 - quietSince >= 1.5) onsets.push(one[k][0] - 0.032);
  // the quiet ends here either way
  let j = k;
  while (j < one.length && one[j][1] >= 0.5) j++;
  quietSince = one[Math.min(j, one.length - 1)][0];
  k = j;
}
// For each of them: when the video had slowed down, relative to it
// (positive: before)
const leads = [];
for (const onset of onsets) {
  if (!reached(onset - 1, onset + 0.5)) continue;
  const before = samples.filter((s) => s && s.t <= onset + 3 && s.t >= onset - 3);
  // the last sample at gameplay speed before talk speed set in around the onset
  let switchAt = null;
  for (let i = 1; i < before.length; i++) if (before[i - 1].rate > 1.1 && before[i].rate < 1.1) switchAt = switchAt ?? before[i].t;
  if (before.length && before[0].rate < 1.1 && switchAt === null) continue;   // already slow: not an onset reached fast
  leads.push(switchAt === null ? null : onset - switchAt);
}
if (rest.includes('--trace')) {
  const changes = samples.filter((x, i) => x && i > 0 && samples[i - 1] && samples[i - 1].rate !== x.rate).map((x) => `${x.t.toFixed(2)}→${x.rate}`);
  console.log('speed changes:', changes.join(' '));
  console.log('model onsets at 1x:', onsets.map((a) => a.toFixed(2)).join(' '));
}
const ok = leads.filter((x) => x !== null).sort((a, b) => a - b);
console.log(JSON.stringify({
  browser: browserName,
  clip: clip.name,
  page: live ? 'plain file (live)' : 'MSE (look-ahead)',
  modes: [...modes],
  speechAtTalkSpeed: `${(100 * heard / speech).toFixed(1)}%`,
  onsetsReachedFast: leads.length,
  slowedBeforeOnset: ok.filter((x) => x >= 0).length,
  medianLeadSec: ok.length ? +ok[ok.length >> 1].toFixed(2) : null,
  missed: leads.filter((x) => x === null).length,
}));
