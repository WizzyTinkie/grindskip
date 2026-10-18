# Evaluation

Phase 3's harness: records the test clips in Chrome and Firefox through the extension, then replays them offline through the controller to score it against speech labels and to search for better thresholds. Results are in [REPORT.md](REPORT.md).

## Setup

Needs Node.js 24, ffmpeg, Firefox (`/usr/bin/firefox`), PipeWire or PulseAudio (`pactl`), and Python 3 for yt-dlp.

```bash
npm install
```

Puppeteer downloads Chrome for Testing into `~/.cache/puppeteer` (npm's install scripts are blocked; Puppeteer is approved in `package.json`).

```bash
python3 -m venv .venv && .venv/bin/pip install yt-dlp
```

The test set is in `lib/clips.mjs`: sections of five Let's Play videos of Risen. Download each section's audio into `media/<name>_<start>-<end>.webm`, with exact cuts, and its auto-captions into `media/subs/<video id>.en.json3`, for example:

```bash
.venv/bin/yt-dlp --js-runtimes node -f 'bestaudio[ext=webm]/bestaudio' --download-sections '*390-690' --force-keyframes-at-cuts -o 'media/sparse_390-690.%(ext)s' 'https://www.youtube.com/watch?v=v4w8WzKm0Mg'
```

```bash
.venv/bin/yt-dlp --js-runtimes node --skip-download --write-auto-subs --sub-langs en --sub-format json3 -o 'media/subs/%(id)s' 'https://www.youtube.com/watch?v=v4w8WzKm0Mg'
```

The speech labels are the captions' word timings as they are (`lib/labels.mjs`); tags such as `[Music]` don't count. `node run.mjs --labels` shows how well they line up with what the model hears.

## Recording

The evaluation build is the extension with a hook that lets the test driver set Grindskip's settings and start and stop its debug recording from the page (`ext/content.js`):

```bash
node ../scripts/build.mjs --eval
```

```bash
node record.mjs chrome
```

This plays every clip at 1x, 2x, 2.5x, 3x and 4x (both of Grindskip's speeds set to the same value) into a temporary null sink, so nothing comes out of the speakers, and writes `recordings/<browser>/<clip>-<speed>x.json`: the 16 kHz audio the extension analysed, the browser's speech probabilities, the media times and the inference times, frame by frame. `--clips`, `--speeds` and `--jobs` (parallel browsers, default 3) narrow it down; `--csp strict` records on a page whose CSP makes Chrome use the offscreen document. Both browsers take about 25 minutes in all.

A debug recording saved from the popup has the same format, so a session from real use can be inspected the same way.

## Scoring and tuning

```bash
node run.mjs
```

Replays each clip closed-loop: the controller hears the recording at the speed it has chosen, and a speed change reaches the audio two frames late. Prints, per browser and clip:

- **speech at talk speed:** the share of the labelled speech played at talk speed;
- **quiet at gameplay speed:** the share of the media without speech played at gameplay speed, leaving out the wait after each stretch of speech;
- **false slowdowns:** switches to talk speed with no labelled speech from 1.5 s before to 1 s after, per minute of media without speech;
- **median delay:** from a labelled onset reached at gameplay speed to the switch, in wall time; **missed:** onsets with no switch within 3 s;
- the browsers' inference time per frame.

`--play 2,2.5,3,4` scores other gameplay speeds, `--set key=value` changes a setting or a controller parameter (`--set startHigh=0.85`, `--set rewind=true`), and `--sweep` searches the thresholds and the minimum speech duration at each gameplay speed. `--probs node` reruns Silero under Node on the recorded audio instead of using the browser's probabilities (`--model` for another model, as in Phase 5).
