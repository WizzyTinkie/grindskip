// Grindskip on any site with the evaluation build (node scripts/build.mjs
// --eval): opens the page (--twitch-live: the first live channel in
// Twitch's directory; --twitch-vod: its latest past broadcast), plays its largest video into a null sink, turns
// Grindskip on and prints its status every 2 s: whether it listens ahead or
// live, the state, the speed and any note.
//
// Usage: node spikes/lookahead/check-site.mjs chrome|firefox <url> [--sec 20] [--play 2.5]
//        node spikes/lookahead/check-site.mjs chrome|firefox --twitch-live|--twitch-vod
import { evalCmd, launch, nullSink, sleep, waitForEval } from '../../eval/lib/harness.mjs';

const [browserName, ...rest] = process.argv.slice(2);
const opt = (k, d) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : d;
};
const sec = +opt('--sec', 20);
const play = +opt('--play', 2.5);
let url = rest.find((x) => /^https?:/.test(x));

const rejectCookies = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^\s*(reject( all)?|decline|necessary only|only necessary)\s*$/i.test(x.textContent));
  b?.click();
  return !!b;
});

const unload = nullSink();
const browser = await launch(browserName);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const firstCard = () => page.waitForFunction(() => document.querySelector('a[data-a-target="preview-card-image-link"]')?.href, { timeout: 30000 }).then((h) => h.jsonValue());
  if (rest.includes('--twitch-live') || rest.includes('--twitch-vod')) {
    await page.goto('https://www.twitch.tv/directory/all', { waitUntil: 'domcontentloaded' });
    await sleep(4000);
    await rejectCookies(page);
    url = await firstCard();
  }
  if (rest.includes('--twitch-vod')) {
    // That channel's latest past broadcast
    await page.goto(`${url}/videos?filter=archives&sort=time`, { waitUntil: 'domcontentloaded' });
    await sleep(4000);
    url = await firstCard();
  }
  console.log(url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await rejectCookies(page);
  await page.evaluate(() => document.querySelector('[data-a-target="content-classification-gate-overlay-start-watching-button"]')?.click());
  await waitForEval(page);
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.readyState >= 2), { timeout: 30000 });
  await page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    v.muted = false;
    return v.play().catch(() => {});
  });
  await evalCmd(page, 'settings', { enabled: true, talkSpeed: 1, playSpeed: play });
  for (let s = 0; s < sec; s += 2) {
    await sleep(2000);
    const st = await evalCmd(page, 'status');
    console.log(`${browserName} mode=${st.mode} where=${st.where} state=${st.state} speed=${st.speed} p=${st.p?.toFixed(2)} note=${st.note} lookahead=${JSON.stringify({ found: st.lookahead?.found, buffers: st.lookahead?.buffers })}`);
  }
} finally {
  await browser.close();
  unload();
}
