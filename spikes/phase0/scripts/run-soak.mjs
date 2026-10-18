// Spike 1 fallback lifetime: does the extension context that runs the model
// (Chrome's service worker or offscreen document, Firefox's background
// page) stay up through a long video while frames stream to it?
//
// Usage: node scripts/run-soak.mjs chrome|firefox bg|offscreen [--sec 360]
import { writeFileSync } from 'node:fs';
import { launch, startServer, nullSink, cmd, waitForSpike } from '../lib/harness.mjs';

const [browserName, target, ...rest] = process.argv.slice(2);
const sec = +(rest[rest.indexOf('--sec') + 1] ?? 360) || 360;

const unload = nullSink();
const server = await startServer();
const { browser } = await launch(browserName);
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/pages/player.html?src=/media/bumpy_0-120.webm&csp=strict`, { waitUntil: 'load' });
  await waitForSpike(page);
  if (target === 'offscreen') await cmd(page, 'benchRemote', { target, frames: 5 });
  const res = await cmd(page, 'soakRemote', { target, sec }, (sec + 60) * 1000);
  console.log(JSON.stringify({ browser: browserName, ...res }));
  writeFileSync(`results/soak-${browserName}-${target}.json`, JSON.stringify({ browser: browserName, ...res }, null, 1));
} finally {
  await browser.close();
  await server.close();
  unload();
}
