# Grindskip: plan

Grindskip is a Chrome and Firefox extension for gameplay videos. It plays the video fast while no one is talking and at normal speed while someone is, so you skip the grind and keep the commentary. Speech is detected with [Silero VAD](https://github.com/snakers4/silero-vad), a small speech-detection model that runs locally in the browser. No audio leaves the computer.

Grindskip grows out of [speech-speed-firefox-advanced](https://github.com/WizzyTinkie/speech-speed-firefox-advanced), a fork of [Speech Speed](https://github.com/ywong137/speech-speed) by Yishan Wong.

## Decisions

| Topic | Decision |
|---|---|
| Name | Grindskip (repo `grindskip`) |
| License | Apache 2.0. The MIT notices of Speech Speed, Silero VAD and ONNX Runtime go in `THIRD_PARTY_NOTICES.md`. |
| Speech detection | Silero VAD only. The rhythm detector from the old repo is dropped. |
| What counts as speech | Any voice: the commentator, in-game dialogue and cutscenes all play at talk speed. |
| Build | npm + esbuild, producing `dist/chrome` and `dist/firefox`. Requires Node.js LTS. |
| Rewind on speech | Included in v1 as an opt-in setting, off by default. |
| Distribution | Publish to the Chrome Web Store and Firefox Add-ons (AMO). |

## Lessons carried over from the old repo

- **Audio lag after speed changes:** after a `playbackRate` change, the captured audio keeps the old rate for about 300 ms (measured in Chrome). Decisions therefore lag the audio by that much. The video's `currentTime` follows the audio and shows when the switch has happened.
- **4x limit:** browsers mute the audio above about 4x (Firefox above 4x; Chromium went silent at 5x in testing), so the gameplay speed stops at 4x.
- **Trusted Types:** YouTube enforces Trusted Types, so in page context the overlay must be built with DOM calls, never `innerHTML`.
- **Proven capture path:** capture via `captureStream()` / `mozCaptureStream()` into an `AnalyserNode` polled every 30 ms works under YouTube's Content Security Policy. An AudioWorklet loaded from a blob URL was blocked there in the original project.
- **Test on real videos:** synthetic test audio misled the old rhythm detector. Tuning must use real gameplay videos with known speech times; YouTube's auto-generated captions give word timings.
- **Firefox reloads:** Firefox keeps a temporary add-on's old code until you click Reload in `about:debugging`.

## Architecture

```
video ─ captureStream ─ AnalyserNode (polled every 30 ms)
      → downsample 48 kHz → 16 kHz → 512-sample frames (32 ms)
      → Silero VAD (ONNX Runtime Web, WebAssembly, 1 thread) → speech probability per frame
      → controller (thresholds, wait, speeds, optional rewind) → video.playbackRate
```

## Repository layout (target)

```
src/
  content/      video.js, capture.js, speed.js, overlay.js, main.js
  vad/          silero.js (model session and state), resample.js
  controller/   controller.js (pure decision logic)
  popup/        popup.html, popup.js, popup.css
  shared/       settings.js (defaults, storage, migration)
assets/         icons, silero_vad.onnx
manifest/       base.json, chrome.json, firefox.json
scripts/        build.mjs (esbuild, copies wasm and model, writes dist/<browser>)
test/           unit tests (Node's built-in test runner)
eval/           evaluation harness and labelled samples
```

## Phases

### Phase 0: Spikes (answer the risky questions first)

1. **Where the model runs.** First try ONNX Runtime Web directly in the content script on YouTube, in Chrome and Firefox. If the page blocks WebAssembly there, run it in an extension page and send the audio frames over a message port: an offscreen document in Chrome, the background page in Firefox.
2. **Sped-up speech.** Compare Silero's speech probabilities on real commentary at 1x, 2x, 2.5x and 3x, both time-stretched with ffmpeg and captured in the browser. This decides whether we need a different threshold at gameplay speed.
3. **Cost.** Time per 32 ms frame in each browser, memory use, and the size of the packaged extension.
4. **Firefox basics.** Does the video stay audible with `mozCaptureStream()`? How long is the audio lag after a speed change, and where does the mute limit start?

Exit: the architecture is chosen, starting thresholds are known, and there's a go/no-go decision.

### Phase 1: Scaffold

- `package.json` with `onnxruntime-web` as a dependency, and esbuild, `web-ext` and ESLint as development dependencies.
- `npm run build` writes `dist/chrome` and `dist/firefox` from `manifest/base.json` plus per-browser additions (Firefox: a fixed add-on ID in `browser_specific_settings.gecko.id`). `npm run watch` rebuilds on save.
- `npm test` runs unit tests with Node's built-in test runner.
- `THIRD_PARTY_NOTICES.md`: Speech Speed (MIT, Yishan Wong), Silero VAD (MIT, Silero Team), ONNX Runtime (MIT, Microsoft).
- `.gitignore`: `node_modules/`, `dist/`, `.idea/`.

### Phase 2: Core

1. **`video.js`:** finds the largest video, re-attaches when YouTube swaps it, and tracks pause, seek and buffering. Ported from the old repo.
2. **`capture.js` and `resample.js`:** capture, a 48 → 16 kHz downsampler with a low-pass filter, and 512-sample framing.
3. **`silero.js`:** the Silero v5 session. It carries the recurrent state between frames and resets it on seek or re-attach.
4. **`controller.js`:** pure logic with no browser APIs, unit-tested on recorded probability traces. It turns probabilities and time into a state and a speed:
   - a start threshold and a lower end threshold;
   - a minimum speech duration before switching;
   - the wait before speeding up;
   - an instant speed switch;
   - rewind on speech (opt-in, off by default), with safeguards: only after a few seconds at gameplay speed, at most about 1.5 s back, never right after a manual seek.
5. **`speed.js`:** applies `playbackRate`, caps it at 4x, restores 1x when turned off, and backs off when the user changes the speed themselves.
6. **UI:**
   - **Popup:** on/off, the current state and speed, speed while talking, speed while playing, wait before speeding up, sensitivity, and rewind on speech.
   - **Overlay:** speech probability meter and state, built with DOM calls.
   - **Settings:** saved in `storage.local`, with defaults and migration.

### Phase 3: Evaluation and tuning

- **Test set:** 3–5 real segments, including the RISEN video (0–60 s: music intro, then continuous commentary) and a gameplay stretch with little talking. Speech times come from the auto-generated captions, corrected by hand where needed.
- **Debug recording:** started by the user, it saves the analysed 16 kHz audio, probabilities, speeds and video times to a file.
- **Offline replay:** the same controller and model run under Node on the recordings, and on time-stretched copies, for fast threshold sweeps.
- **Metrics:**
  - commentary heard at talk speed (%);
  - delay before switching to talk speed;
  - non-commentary played at gameplay speed (%);
  - false slowdowns per minute;
  - CPU per frame.
- **Final check:** in Chrome and Firefox on the real videos.

### Phase 4: Polish and release

- Keyboard shortcut to toggle.
- Icons (16, 32, 48 and 128 px), store screenshots and descriptions.
- README with credits, and the website text.
- Privacy statement: no data collected, nothing leaves the device.
- Firefox Add-ons: fixed add-on ID; the source code and build instructions are submitted with each release, because the code is bundled.
- Chrome Web Store: developer account (one-time registration fee).

### Phase 5 (optional): Fine-tuning

If music or sound effects still trigger speech, fine-tune Silero on labelled gameplay audio with the `tuning` scripts in the Silero VAD repo. They need PyTorch and speech start and end times accurate to about 30 ms.

## Targets (measured on the test set)

| Measure | Target |
|---|---|
| Commentary heard at talk speed | ≥ 95% (≥ 99% with rewind on) |
| Non-commentary played at gameplay speed | ≥ 90% |
| Median delay before switching to talk speed | ≤ 0.4 s |
| CPU | ≤ 5% of one core |
| Package size | ≤ 15 MB |
| Browsers | Latest Chrome and Firefox, on YouTube |

## Risks

- **Sped-up speech is recognised less well.** Possible fixes: a lower threshold at gameplay speed, rewind on speech, or a lower default gameplay speed.
- **WebAssembly is blocked in the content script.** Then the model runs in an extension page, which means more plumbing, and Firefox may suspend an idle background page.
- **Vocals in game music count as speech.** Fine-tuning can help.
- **Store review of bundled code.** Keep the bundle unminified and the build reproducible.
