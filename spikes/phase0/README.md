# Phase 0 spikes

Throwaway code that answered the Phase 0 questions in [PLAN.md](../../PLAN.md). The findings are in [REPORT.md](REPORT.md). Nothing here is product code, but `lib/silero.js` and `lib/resample.js` are meant to seed `src/vad/`.

## Setup

Needs Node.js 24, ffmpeg, Firefox, PipeWire or PulseAudio (`pactl`, `parecord`), and Python 3 for yt-dlp.

```bash
npm install
```

npm blocks install scripts here; esbuild and Puppeteer are approved in `package.json` (`allowScripts`). Puppeteer downloads Chrome for Testing into `~/.cache/puppeteer`. Firefox is the installed one at `/usr/bin/firefox`.

```bash
./scripts/fetch-models.sh
```

The three commentary clips come from YouTube (see `lib/clips.mjs` for the videos and sections). Download them with yt-dlp into `media/` under the names in `lib/clips.mjs`, plus the auto-captions as `media/subs/<video id>.en.json3`:

```bash
yt-dlp --js-runtimes node -f 'bestaudio[ext=webm]/bestaudio' --download-sections '*0-120' -o 'media/bumpy_0-120.%(ext)s' 'https://www.youtube.com/watch?v=4ThQDMlPWM0'
```

```bash
yt-dlp --js-runtimes node --skip-download --write-auto-subs --sub-langs en --sub-format json3 -o 'media/subs/%(id)s' 'https://www.youtube.com/watch?v=4ThQDMlPWM0'
```

Then generate the synthetic sweep video and the Opus copy of the AAC clip:

```bash
./scripts/make-media.sh
```

## Running

Every browser run plays into its own temporary null sink (removed on exit), so nothing comes out of the speakers.

| Spike | Command | Output |
|---|---|---|
| 2, offline | `node scripts/speed-offline.mjs` then `node scripts/analyze.mjs results/traces-ffmpeg.json` | `results/scores-ffmpeg.md` |
| build the test extension | `node scripts/build-ext.mjs` (`--no-wasm-csp`, `--out dir`) | `build/chrome`, `build/firefox` |
| 1 and 3, local page | `node scripts/run-bench.mjs chrome` (`--csp strict`, `--remote bg\|offscreen`, `--ext dir`) | `results/bench-*.json` |
| 1 and 3, YouTube | `node scripts/run-youtube.mjs firefox` | `results/youtube-*.json` |
| 1, fallback lifetime | `node scripts/run-soak.mjs chrome offscreen` | `results/soak-*.json` |
| 2, browser | `node scripts/run-clips.mjs chrome`, then `node scripts/replay-pcm.mjs chrome` | `results/traces-chrome.json`, `results/pcm-chrome/` |
| 3, memory | `node scripts/run-memory.mjs chrome --wasm-load url` | `results/memory-*.json` |
| 4 | `node scripts/run-media.mjs firefox` (`audible`, `lag`, `mute`, `--mse`) | `results/media-*.json` |

Score everything together with:

```bash
node scripts/analyze.mjs results/traces-ffmpeg.json results/traces-chrome.json results/traces-firefox.json
```

## Layout

- `lib/`: Silero session, resampler, captions, metrics, clip list, browser harness
- `ext/`: the test extension (content script, plus the background/offscreen fallback)
- `pages/`: local test pages (player, media test)
- `scripts/`: one script per measurement
- `results/`: measurements (the large traces and audio are not committed)
