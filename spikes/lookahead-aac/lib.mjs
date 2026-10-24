// Plumbing for the AAC spike: the two browsers (into a null sink, autoplay
// allowed) and a static server for pages/, fmp4.js and the
// extension's src/. WebCodecs needs a
// secure context, which 127.0.0.1 is.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { nullSink, SINK } from '../../eval/lib/harness.mjs';

export { sleep } from '../../eval/lib/harness.mjs';

export const puppeteer = createRequire(new URL('../../eval/package.json', import.meta.url))('puppeteer');
export const DIR = import.meta.dirname;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.mp4': 'video/mp4' };

export function startServer() {
  const server = createServer((req, res) => {
    // /src/ is the extension's own code
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const root = p.startsWith('/src/') ? join(DIR, '../..') : DIR;
    const path = join(root, p);
    if (!path.startsWith(root)) return res.writeHead(403).end();
    try {
      if (!statSync(path).isFile()) throw new Error();
    } catch {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

// Returns { browser, close }; close also unloads the sink
export async function launch(browserName) {
  const unload = nullSink();
  const env = { ...process.env, PULSE_SINK: SINK };
  const browser = browserName === 'chrome'
    ? await puppeteer.launch({ browser: 'chrome', headless: true, pipe: true, ignoreDefaultArgs: ['--mute-audio'], args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1280,900'], env })
    : await puppeteer.launch({ browser: 'firefox', executablePath: '/usr/bin/firefox', headless: true, extraPrefsFirefox: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 }, args: ['--width=1280', '--height=900'], env });
  return {
    browser,
    async close() {
      await browser.close();
      unload();
    },
  };
}

export const toB64 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
