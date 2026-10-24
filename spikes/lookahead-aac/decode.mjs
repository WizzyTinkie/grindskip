// Decodes the audio the probe saved (results/*.bin) with WebCodecs'
// AudioDecoder in the browser: demuxes it with fmp4.js (or the extension's
// webm.js), configures the decoder from the init segment, and reports
// whether the config is supported, what comes out (sample rate, channels,
// timestamps against the input's) and how long it took. --save writes the
// decoded mono audio to results/<file>-<browser>.f32 with a .f32.json of its
// start and rate, for compare.mjs.
//
// Usage: node spikes/lookahead-aac/decode.mjs chrome|firefox [--save] results/<file>.bin...
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DIR, launch, startServer } from './lib.mjs';

const [browserName, ...rest] = process.argv.slice(2);
const save = rest.includes('--save');
const files = rest.filter((x) => x.endsWith('.bin'));

const server = await startServer();
const { browser, close } = await launch(browserName);
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/pages/blank.html`);
  await page.addScriptTag({ type: 'module', content: `
    import { createMp4Demuxer } from '/fmp4.js';
    import { createWebmDemuxer } from '/src/lookahead/webm.js';
    Object.assign(window, { createMp4Demuxer, createWebmDemuxer });
  ` });
  await page.waitForFunction(() => window.createMp4Demuxer);
  for (const file of files) {
    const bytes = readFileSync(join(DIR, file));
    const r = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const webm = bytes[0] === 0x1a;
      const t0 = performance.now();
      const demux = webm ? window.createWebmDemuxer() : window.createMp4Demuxer();
      // In appends' worth of chunks, so a new init segment configures anew
      const groups = [];
      for (let i = 0; i < bytes.length; i += 64 * 1024) {
        const frames = demux.push(bytes.subarray(i, i + 64 * 1024));
        const track = [...demux.tracks.values()].find((t) => t.handler === 'soun' || t.codec === 'A_OPUS');
        if (!track) continue;
        if (!groups.length || groups.at(-1).track !== track) groups.push({ track, frames: [] });
        groups.at(-1).frames.push(...frames.filter((f) => f.track === (track.id ?? track.number)));
      }
      const t1 = performance.now();
      const out = { groups: [], outputs: [] };
      const parts = [];
      let decodeMs = 0;
      for (const { track, frames } of groups) {
        const config = webm
          ? { codec: 'opus', sampleRate: track.sampleRate, numberOfChannels: track.channels, description: track.setup }
          : { codec: track.codec, sampleRate: track.sampleRate, numberOfChannels: track.channels, ...(track.description ? { description: track.description } : {}) };
        const support = await AudioDecoder.isConfigSupported(config).then((s) => s.supported, (e) => `throws: ${e.message}`);
        const g = { codec: config.codec, configRate: config.sampleRate, configChannels: config.numberOfChannels, edit: track.edit ?? null, supported: support, frames: frames.length, in: frames.length ? [frames[0].timestamp, frames.at(-1).timestamp] : null };
        out.groups.push(g);
        if (support !== true || !frames.length) continue;
        let error = null;
        const outputs = [];
        const decoder = new AudioDecoder({
          output: (a) => {
            const n = a.numberOfFrames;
            const mono = new Float32Array(n);
            const plane = new Float32Array(n);
            for (let c = 0; c < a.numberOfChannels; c++) {
              a.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
              for (let i = 0; i < n; i++) mono[i] += plane[i] / a.numberOfChannels;
            }
            outputs.push({ t: a.timestamp / 1e6, n, rate: a.sampleRate, ch: a.numberOfChannels });
            parts.push({ t: a.timestamp / 1e6, rate: a.sampleRate, mono });
            a.close();
          },
          error: (e) => { error = e.message; },
        });
        const td = performance.now();
        decoder.configure(config);
        for (const f of frames) decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(f.timestamp * 1e6), data: f.data }));
        await decoder.flush().catch((e) => { error ??= e.message; });
        decodeMs += performance.now() - td;
        g.error = error;
        g.outputs = outputs.length;
        if (outputs.length) {
          g.outRate = [...new Set(outputs.map((o) => o.rate))];
          g.outChannels = [...new Set(outputs.map((o) => o.ch))];
          g.out = [outputs[0].t, outputs.at(-1).t];
          g.seconds = outputs.reduce((s, o) => s + o.n / o.rate, 0);
          // Output timestamps that don't follow on from the one before
          g.steps = outputs.slice(1).filter((o, i) => Math.abs(o.t - (outputs[i].t + outputs[i].n / outputs[i].rate)) > 0.002).length;
          // First output against the first input: priming, if trimmed
          g.firstOutVsIn = +(outputs[0].t - frames[0].timestamp).toFixed(4);
        }
      }
      out.demuxMs = +(t1 - t0).toFixed(1);
      out.decodeMs = +decodeMs.toFixed(1);
      // One stretch of mono audio from the first output on, for compare.mjs
      if (parts.length) {
        const rate = parts[0].rate;
        const same = parts.filter((p) => p.rate === rate);
        const total = same.reduce((s, p) => s + p.mono.length, 0);
        const all = new Float32Array(total);
        let o = 0;
        for (const p of same) {
          all.set(p.mono, o);
          o += p.mono.length;
        }
        const u8 = new Uint8Array(all.buffer);
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        out.pcm = { start: parts[0].t, rate, b64: btoa(s) };
      }
      return out;
    }, bytes.toString('base64'));
    const pcm = r.pcm;
    delete r.pcm;
    console.log(browserName, file, JSON.stringify(r));
    if (save && pcm) {
      const stem = join(DIR, 'results', `${basename(file, '.bin')}-${browserName}`);
      writeFileSync(`${stem}.f32`, Buffer.from(pcm.b64, 'base64'));
      writeFileSync(`${stem}.f32.json`, JSON.stringify({ start: pcm.start, rate: pcm.rate }));
    }
  }
} finally {
  await close();
  await server.close();
}
