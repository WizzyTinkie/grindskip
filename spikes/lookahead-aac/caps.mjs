// Which audio codecs can each browser's WebCodecs AudioDecoder decode, and
// which can its Media Source play? Asks AudioDecoder.isConfigSupported with
// a real AudioSpecificConfig for each AAC profile, and
// MediaSource.isTypeSupported for the MIME types players use.
//
// Usage: node spikes/lookahead-aac/caps.mjs chrome|firefox
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, launch, startServer } from './lib.mjs';

const browserName = process.argv[2];
const server = await startServer();
const { browser, close } = await launch(browserName);
let out;
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/pages/blank.html`);
  out = await page.evaluate(async () => {
    // AudioSpecificConfig: object type (5 bits), rate index (4), channels (4)
    const asc = (aot, rateIndex, ch) => new Uint8Array([(aot << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (ch << 3)]);
    // HE-AAC with explicit SBR signalling: AOT 5, core rate, ext rate, AOT 2
    const heAsc = (core, ext, ch) => {
      const bits = [[5, 5], [core, 4], [ch, 4], [ext, 4], [2, 5]];
      let v = 0n;
      let n = 0;
      for (const [x, w] of bits) {
        v = (v << BigInt(w)) | BigInt(x);
        n += w;
      }
      const pad = (8 - (n % 8)) % 8;
      v <<= BigInt(pad);
      const bytes = [];
      for (let i = (n + pad) / 8 - 1; i >= 0; i--) bytes.push(Number((v >> BigInt(i * 8)) & 0xffn));
      return new Uint8Array(bytes);
    };
    const opusHead = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
    const configs = {
      'AAC-LC 44.1 kHz stereo': { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, description: asc(2, 4, 2) },
      'AAC-LC 48 kHz stereo': { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: asc(2, 3, 2) },
      'AAC-LC 48 kHz 5.1': { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 6, description: asc(2, 3, 6) },
      'AAC-LC, no description (ADTS)': { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      'HE-AAC v1 (SBR) 24/48 kHz': { codec: 'mp4a.40.5', sampleRate: 48000, numberOfChannels: 2, description: heAsc(6, 3, 2) },
      'HE-AAC v2 (PS) 24/48 kHz': { codec: 'mp4a.40.29', sampleRate: 48000, numberOfChannels: 2, description: heAsc(6, 3, 1) },
      'Opus 48 kHz stereo': { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: opusHead },
      'MP3': { codec: 'mp3', sampleRate: 44100, numberOfChannels: 2 },
      'FLAC': { codec: 'flac', sampleRate: 44100, numberOfChannels: 2 },
      'AC-3': { codec: 'ac-3', sampleRate: 48000, numberOfChannels: 2 },
      'E-AC-3': { codec: 'ec-3', sampleRate: 48000, numberOfChannels: 2 },
    };
    const decoder = {};
    for (const [name, config] of Object.entries(configs)) {
      try {
        decoder[name] = (await AudioDecoder.isConfigSupported(config)).supported;
      } catch (e) {
        decoder[name] = `throws: ${e.name}`;
      }
    }
    const types = [
      'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="mp4a.40.5"', 'audio/mp4; codecs="mp4a.40.29"',
      'audio/mp4; codecs="opus"', 'audio/mp4; codecs="flac"', 'audio/mp4; codecs="ec-3"', 'audio/mpeg', 'audio/aac',
      'audio/webm; codecs="opus"', 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
    ];
    const mse = Object.fromEntries(types.map((t) => [t, MediaSource.isTypeSupported(t)]));
    return { userAgent: navigator.userAgent, decoder, mse };
  });
} finally {
  await close();
  await server.close();
}
writeFileSync(join(DIR, 'results', `caps-${browserName}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
