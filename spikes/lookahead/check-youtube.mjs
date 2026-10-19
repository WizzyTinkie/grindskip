// Look-ahead in the extension, on YouTube: plays a video with the evaluation
// build (node scripts/build.mjs --eval) into a null sink, turns Grindskip on,
// and prints the look-ahead status from the content script every 2 s: whether
// the hook found the video's MediaSource, its audio buffers, the frames
// analysed and how far the analysis reaches beyond the playing position.
//
// A consent page is answered with "Reject all". A bot check stops the run.
//
// Usage: node spikes/lookahead/check-youtube.mjs chrome|firefox [--video ID] [--sec 20] [--seek 300] [--play 2.5]
import { evalCmd, launch, nullSink, sleep, waitForEval } from '../../eval/lib/harness.mjs';

const [browserName, ...rest] = process.argv.slice(2);
const opt = (k, d) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : d;
};
const videoId = opt('--video', 'BFG1Q7zpNtE');
const sec = +opt('--sec', 20);
const seek = opt('--seek', null);
const play = +opt('--play', 1);

const unload = nullSink();
const browser = await launch(browserName);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded' });
  const rejected = await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^\s*reject all\s*$/i.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  }, { timeout: 15000, polling: 500 }).then(() => true).catch(() => false);
  if (rejected) await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  if (await page.evaluate(() => /confirm you.re not a bot/i.test(document.body?.innerText ?? ''))) throw new Error('YouTube asked for a bot check; stopping');
  await waitForEval(page);

  const VIDEO = '#movie_player video';
  await page.waitForFunction((sel) => document.querySelector(sel)?.readyState >= 2, { timeout: 30000 }, VIDEO);
  await page.evaluate((sel) => document.querySelector(sel).play().catch(() => {}), VIDEO);
  await page.waitForFunction((sel) => document.querySelector(sel).currentTime > 1, { timeout: 30000 }, VIDEO);
  // With --play 1 (the default) Grindskip analyses but leaves the speed alone
  await evalCmd(page, 'settings', { enabled: true, talkSpeed: 1, playSpeed: play });
  for (let s = 0; s < sec; s += 2) {
    if (seek && s === Math.floor(sec / 2 / 2) * 2) {
      // Through the player, as a click on its progress bar would
      await page.evaluate((t) => document.querySelector('#movie_player').seekTo(t, true), +seek);
      console.log(`-- seek to ${seek} s`);
    }
    await sleep(2000);
    const st = await evalCmd(page, 'status');
    const la = st.lookahead;
    const { t, paused } = await page.evaluate((sel) => ({ t: document.querySelector(sel).currentTime, paused: document.querySelector(sel).paused }), VIDEO);
    console.log(`${browserName} t=${t.toFixed(1)}${paused ? ' paused' : ''} rate=${st.speed} mode=${st.mode} state=${st.state} found=${la?.found} buffers=${JSON.stringify(la?.buffers)} analysed=${la?.analysed} decodedUntil=${la?.decodedUntil?.toFixed(1)} ahead=${la?.ahead} error=${la?.error} where=${st.where}`);
  }
} finally {
  await browser.close();
  unload();
}
