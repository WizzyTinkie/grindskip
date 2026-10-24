// What players hand to Media Source Extensions when the audio isn't Opus
// in WebM. Hooks MediaSource and SourceBuffer before the page's scripts,
// plays the largest video into a null sink for a while, and reports for
// each SourceBuffer: its MIME type, the boxes its appends start with, and
// what the player sets on it (timestampOffset, mode, appendWindow,
// changeType, remove, abort), the buffered ranges after the first appends,
// and whether the page asked for DRM. The appends of each audio-carrying
// buffer (up to 3 MB) are saved to results/<target>-<browser>-<n>.bin with
// their boundaries in the JSON, then demuxed here with fmp4.js (or
// lookahead/webm.js) to compare their timestamps with what the browser
// buffered.
//
// Targets: the four common player libraries on public test streams (a
// local page loading them from jsdelivr), YouTube with Opus hidden from the
// player so it picks AAC (and as it is, for the Opus to compare with), and
// some sites. Or any URL.
//
// Usage: node spikes/lookahead-aac/probe.mjs chrome|firefox <target|url> [--sec 20]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWebmDemuxer } from '../../src/lookahead/webm.js';
import { createMp4Demuxer } from './fmp4.js';
import { DIR, launch, sleep, startServer } from './lib.mjs';

const [browserName, targetArg, ...rest] = process.argv.slice(2);
const sec = rest.includes('--sec') ? +rest[rest.indexOf('--sec') + 1] : 20;
const KEEP_BYTES = 3 * 1024 * 1024;

const player = (lib, src) => ({ local: `/pages/player.html?lib=${lib}&src=${encodeURIComponent(src)}` });
const TARGETS = {
  'hlsjs-ts': player('hls', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'),
  'hlsjs-fmp4': player('hls', 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8'),
  'shaka-dash': player('shaka', 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd'),
  'shaka-hls': player('shaka', 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8'),
  'dashjs': player('dash', 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd'),
  'videojs-ts': player('videojs', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'),
  'yt-opus': { url: 'https://www.youtube.com/watch?v=BFG1Q7zpNtE', youtube: true },
  'yt-aac': { url: 'https://www.youtube.com/watch?v=BFG1Q7zpNtE', youtube: true, hideOpus: true },
  'vimeo': { url: 'https://vimeo.com/76979871' },
  'ted': { url: 'https://www.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity' },
  'dailymotion': { url: 'https://www.dailymotion.com/', firstLink: 'a[href*="/video/"]' },
  'twitch-live': { url: 'https://www.twitch.tv/directory/all', firstLink: 'a[data-a-target="preview-card-image-link"]' },
  'kick-live': { url: 'https://kick.com/browse', firstLink: 'a[href^="/"][href*="/"]:has(img)' },
};
const target = TARGETS[targetArg] ?? { url: targetArg };
const name = TARGETS[targetArg] ? targetArg : new URL(targetArg).hostname.replace(/^www\./, '');

// Runs in the page's world before its scripts
function hook({ keep, hideOpus }) {
  const log = {
    workerMse: typeof MediaSource !== 'undefined' && !!MediaSource.canConstructInDedicatedWorker,
    sources: 0,
    buffers: [],
    drm: [],
    setMediaKeys: 0,
  };
  window.__la = log;
  window.__laBuffers = [];
  window.__laBytes = [];
  if (hideOpus) {
    const isTypeSupported = MediaSource.isTypeSupported;
    MediaSource.isTypeSupported = function (t) {
      return /opus/i.test(t) ? false : isTypeSupported.call(this, t);
    };
    const decodingInfo = navigator.mediaCapabilities?.decodingInfo;
    if (decodingInfo) {
      navigator.mediaCapabilities.decodingInfo = function (c) {
        if (/opus/i.test(c?.audio?.contentType ?? '')) return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
        return decodingInfo.call(this, c);
      };
    }
  }
  const rkmsa = navigator.requestMediaKeySystemAccess;
  if (rkmsa) {
    navigator.requestMediaKeySystemAccess = function (ks) {
      log.drm.push(ks);
      return rkmsa.apply(this, arguments);
    };
  }
  const smk = HTMLMediaElement.prototype.setMediaKeys;
  if (smk) {
    HTMLMediaElement.prototype.setMediaKeys = function (k) {
      if (k) log.setMediaKeys++;
      return smk.apply(this, arguments);
    };
  }
  const seen = new WeakMap();
  const boxTypes = (b) => {
    const out = [];
    for (let p = 0; p + 8 <= b.length && out.length < 4;) {
      const size = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (!/^[a-z0-9 ]{4}$/i.test(t)) {
        out.push(b[0] === 0x1a && b[1] === 0x45 ? 'EBML' : b[0] === 0x1f && b[1] === 0x43 ? 'Cluster' : p ? '…' : '(mid-box)');
        break;
      }
      out.push(t);
      if (size < 8) break;
      p += size;
    }
    return out.join(',');
  };
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    if (!seen.has(this)) seen.set(this, log.sources++);
    const sb = addSourceBuffer.call(this, mime);
    const id = log.buffers.length;
    sb.__laId = id;
    const audio = /audio|mp4a|opus|ac-3|ec-3|flac|mp3/i.test(mime) && !(/^video\//i.test(mime) && !/mp4a|opus|ac-3|ec-3|flac/i.test(mime));
    log.buffers.push({ mime, source: seen.get(this), audio, appends: 0, bytes: 0, starts: [], offsets: [], modes: [], windows: [], changeType: [], removes: 0, aborts: 0, buffered: [], kept: [] });
    window.__laBuffers.push(sb);
    window.__laBytes.push([]);
    sb.addEventListener('updateend', () => {
      const b = log.buffers[id];
      // In sequence mode the browser moves timestampOffset itself: what it
      // is after the append is what applied to it
      if (b.pending) {
        b.pending.after = +sb.timestampOffset.toFixed(4);
        b.pending = null;
      }
      if (b.buffered.length >= 6) return;
      try {
        const r = sb.buffered;
        const ranges = [];
        for (let i = 0; i < r.length; i++) ranges.push([+r.start(i).toFixed(4), +r.end(i).toFixed(4)]);
        b.buffered.push({ after: b.appends, ranges });
      } catch { /* removed */ }
    });
    return sb;
  };
  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const b = log.buffers[this.__laId];
    if (b) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      b.appends++;
      b.bytes += bytes.length;
      const s = boxTypes(bytes);
      if (b.starts.length < 8 || !b.starts.includes(s)) b.starts.push(s);
      const offset = +this.timestampOffset.toFixed(4);
      if (!b.offsets.includes(offset)) b.offsets.push(offset);
      if (!b.modes.includes(this.mode)) b.modes.push(this.mode);
      const w = `${this.appendWindowStart}-${this.appendWindowEnd}`;
      if (!b.windows.includes(w)) b.windows.push(w);
      const keptBytes = b.kept.reduce((a, x) => a + x.n, 0);
      if (b.audio && keptBytes < keep) {
        window.__laBytes[this.__laId].push(bytes.slice());
        b.pending = { n: bytes.length, offset, at: Math.round(performance.now()) };
        b.kept.push(b.pending);
      }
    }
    return appendBuffer.call(this, data);
  };
  const changeType = SourceBuffer.prototype.changeType;
  if (changeType) {
    SourceBuffer.prototype.changeType = function (t) {
      log.buffers[this.__laId]?.changeType.push(t);
      return changeType.apply(this, arguments);
    };
  }
  const remove = SourceBuffer.prototype.remove;
  SourceBuffer.prototype.remove = function () {
    const b = log.buffers[this.__laId];
    if (b) b.removes++;
    return remove.apply(this, arguments);
  };
  const abort = SourceBuffer.prototype.abort;
  SourceBuffer.prototype.abort = function () {
    const b = log.buffers[this.__laId];
    if (b) {
      b.aborts++;
      if (b.audio) b.kept.push({ n: 0, abort: true });
    }
    return abort.apply(this, arguments);
  };
}

const rejectCookies = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^\s*(reject( all)?|decline|necessary only|only necessary|refuse all|odmítnout vše)\s*$/i.test(x.textContent));
  b?.click();
  return !!b;
});

const server = await startServer();
const { browser, close } = await launch(browserName);
const out = { browser: browserName, version: await browser.version(), target: name };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  let url = target.local ? server.url + target.local : target.url;
  if (target.firstLink) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(5000);
    await rejectCookies(page);
    url = await page.waitForFunction((sel) => document.querySelector(sel)?.href, { timeout: 30000 }, target.firstLink).then((h) => h.jsonValue());
  }
  out.url = url;
  await page.evaluateOnNewDocument(hook, { keep: KEEP_BYTES, hideOpus: !!target.hideOpus });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (target.youtube) {
    const rejected = await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^\s*reject all\s*$/i.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    }, { timeout: 15000, polling: 500 }).then(() => true).catch(() => false);
    if (rejected) await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    if (await page.evaluate(() => /confirm you.re not a bot/i.test(document.body?.innerText ?? ''))) throw new Error('YouTube asked for a bot check');
  } else if (!target.local) {
    await sleep(4000);
    out.cookies = await rejectCookies(page);
    await page.evaluate(() => document.querySelector('[data-a-target="content-classification-gate-overlay-start-watching-button"]')?.click());
  }
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.readyState >= 2), { timeout: 45000 });
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
      video: { t: +v.currentTime.toFixed(2), paused: v.paused, src: v.currentSrc.slice(0, 30), srcObject: v.srcObject ? v.srcObject.constructor.name : null },
      ...(window.__la ?? { buffers: [] }),
      ahead,
    };
  }));
  // The kept appends, as base64 to get them out of the page
  const kept = await page.evaluate(() => (window.__laBytes ?? []).map((list) => list.map((b) => {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  })));
  out.buffers?.forEach((b, i) => {
    if (!kept[i]?.length) return;
    const bytes = Buffer.concat(kept[i].map((x) => Buffer.from(x, 'base64')));
    b.file = `results/${name}-${browserName}-${i}.bin`;
    writeFileSync(join(DIR, b.file), bytes);
  });
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String(e);
} finally {
  await close();
  await server.close();
}

// Demuxes what was kept: tracks, samples, and where their timestamps (plus
// timestampOffset) land against what the browser buffered
for (const b of out.buffers ?? []) {
  if (!b.file) continue;
  const bytes = readFileSync(join(DIR, b.file));
  const webm = bytes[0] === 0x1a && bytes[1] === 0x45;
  const demux = webm ? createWebmDemuxer() : createMp4Demuxer();
  const frames = [];
  let p = 0;
  try {
    for (const k of b.kept) {
      if (k.abort) {
        demux.reset({ resync: true });
        continue;
      }
      // An init segment starts afresh, as the extension's hook marks it
      if (bytes.readUInt32BE(p) === 0x1a45dfa3 || ['ftyp', 'moov'].includes(bytes.subarray(p + 4, p + 8).toString('latin1'))) demux.reset({ resync: false });
      frames.push(...demux.push(new Uint8Array(bytes.subarray(p, p + k.n))).map((f) => ({ ...f, offset: b.modes.includes('sequence') ? k.after ?? k.offset : k.offset })));
      p += k.n;
    }
  } catch (e) {
    b.demuxError = String(e);
  }
  const tracks = [...demux.tracks.values()].map(({ description, setup, ...t }) => ({ ...t, description: (description ?? setup) && Buffer.from(description ?? setup).toString('hex').slice(0, 40) }));
  const audio = frames;
  b.demuxed = {
    tracks,
    samples: audio.length,
    firstRaw: audio[0] ? +audio[0].timestamp.toFixed(4) : null,
    first: audio[0] ? +(audio[0].timestamp + audio[0].offset).toFixed(4) : null,
    last: audio.at(-1) ? +(audio.at(-1).timestamp + audio.at(-1).offset).toFixed(4) : null,
    // Sample steps that aren't one sample's duration: jumps in the input
    jumps: audio.slice(1).map((f, i) => [audio[i], f]).filter(([a, f]) => a.duration !== undefined && Math.abs(f.timestamp + f.offset - (a.timestamp + a.offset + a.duration)) > 0.001).slice(0, 5)
      .map(([a, f]) => [+(a.timestamp + a.offset).toFixed(3), +(f.timestamp + f.offset).toFixed(3)]),
    counts: demux.counts,
  };
  b.afterOffsets = [...new Set(b.kept.map((k) => k.after))];
  delete b.kept;
}
writeFileSync(join(DIR, 'results', `probe-${name}-${browserName}.json`), JSON.stringify(out, null, 1));
// A line per buffer; the JSON has the rest
const uniq = (a) => [...new Set(a)];
console.log(`${name} ${browserName}: ${out.ok ? 'ok' : out.error} t=${out.video?.t} sources=${out.sources} workerMse=${out.workerMse} srcObject=${out.video?.srcObject} drm=${JSON.stringify(out.drm?.map((d) => d) ?? [])} setMediaKeys=${out.setMediaKeys}`);
for (const [i, b] of (out.buffers ?? []).entries()) {
  const d = b.demuxed;
  const buffered = b.buffered.find((x) => x.ranges.length)?.ranges[0];
  console.log(`  [${i}] ${b.mime} appends=${b.appends} ${(b.bytes / 1e6).toFixed(2)} MB ahead=${out.ahead?.[i]} starts=${uniq(b.starts).join(' | ')} offsets=${b.offsets.join(',')} modes=${b.modes.join(',')} windows=${b.windows.join(',')} changeType=${b.changeType.join(',') || '-'} removes=${b.removes} aborts=${b.aborts} offsetsAfter=${b.afterOffsets?.join(',') ?? '-'}`);
  if (d) console.log(`      demuxed: ${d.tracks.map((t) => `${t.handler}:${t.codec}@${t.sampleRate}/${t.channels}${t.encrypted ? ' ENCRYPTED' : ''} edit=${t.edit}`).join(' ')} samples=${d.samples} firstRaw=${d.firstRaw} first=${d.first} last=${d.last} buffered=${JSON.stringify(buffered)} jumps=${JSON.stringify(d.jumps)} skipped=${d.counts?.skipped ?? '-'}${b.demuxError ? ` ERROR ${b.demuxError}` : ''}`);
}
