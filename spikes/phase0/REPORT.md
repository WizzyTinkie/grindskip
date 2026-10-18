# Phase 0 report

Date: 2026-10-18. The code and the raw measurements are in this folder; [README.md](README.md) explains how to rerun everything.

## Verdict: go

Silero VAD runs comfortably in the browser, recognises sped-up commentary almost as well as normal-speed commentary, and fits the CPU and download-size targets. Nothing found here blocks the plan. Several of PLAN.md's carried-over lessons don't hold on current browsers, and the risk the plan expected from sped-up speech turned out to be the other way round. Both are listed under [Changes to PLAN.md](#changes-to-planmd).

| Question | Answer |
|---|---|
| Where the model runs | In the content script on YouTube, in both browsers. In Chrome this works only because YouTube's CSP allows `'unsafe-eval'`. On a page without it, Chrome refuses to compile WebAssembly in the content script, so Chrome needs the extension-context fallback, which works (round trip about 1 ms per frame). |
| Model | Silero v6.2, 16 kHz-only export (`silero_vad_16k_op15.onnx`, 1.3 MB). Same output as the full v6.2 file, and better than v5.1.2 at gameplay speeds. |
| Sped-up speech | Still recognised: 97–100% of the speech found at 1x is also found at 2x–4x, and 13 or 14 of the 14 speech onsets are found at every speed. What gets worse with speed is **false** speech in gameplay without talking, so gameplay speed needs a **higher** start threshold, not a lower one. |
| Starting thresholds | Start 0.5 at talk speed, 0.8 at gameplay speed (2x and up); end 0.35; minimum speech 3 frames (96 ms). Default gameplay speed 2.5x; 4x works but triggers false slowdowns several times a minute. |
| CPU | About 19–21 ms of CPU per second of video for the whole pipeline on average, about 2% of one core (target ≤ 5%). |
| Memory | About 100 MB per tab while the model is loaded. Nothing in PLAN.md targets this, but it's worth knowing (see [Spike 3](#spike-3-cost)). |
| Package | 4.8 MB zipped, 15.7 MB unpacked (target ≤ 15 MB). |
| Firefox | `captureStream()` (Firefox 149+) keeps the video audible; `mozCaptureStream()` mutes it unless the capture is routed to the speakers. |

## Setup

- Machine: AMD Ryzen 9 5900X, Linux (CachyOS), PipeWire 1.6.9.
- Browsers: Chrome for Testing 155.0.8059.79 (headless, via Puppeteer 25.14) and Firefox 157.0.1 (headless, via WebDriver BiDi). Each run played into its own temporary null sink, which also let the spikes record what the browser actually outputs.
- ONNX Runtime Web 1.30.0, `onnxruntime-web/wasm` bundle (the WebAssembly glue is bundled into the content script; only the `.wasm` file is separate), one thread, no proxy worker.
- Models: Silero v5.1.2, v6.2 and the v6.2 16 kHz-only export, pinned to commits in `scripts/fetch-models.sh`. Each 512-sample frame is fed with the previous frame's last 64 samples in front of it, like the official wrapper, and the recurrent state is carried between frames.
- Capture path, as planned: `captureStream()` → `AnalyserNode` (32768 samples) polled every 30 ms, using only the samples rendered since the previous poll → a 64-tap windowed-sinc resampler to 16 kHz (flat to 6 kHz, −32 dB at 8.5 kHz, −79 dB at 10 kHz) → 512-sample frames.
- Clips (120 s each, auto-captions as rough word timings):

| Clip | Video | Content |
|---|---|---|
| bumpy | [Let's Play Risen ep. 1](https://www.youtube.com/watch?v=4ThQDMlPWM0), 0–120 s | dense commentary with a quieter stretch |
| mattg | [Let's Play Risen 001](https://www.youtube.com/watch?v=ZCC-wZjgHFo&t=90), 90–210 s | commentary, then about a minute of gameplay with little talking |
| nocomm | [Risen, no commentary](https://www.youtube.com/watch?v=ZJ0hHIcMATk), 0–120 s | music, narrated intro (in-game voice), game sound |

## Spike 1: where the model runs

**Content script on YouTube: works in both browsers.** ORT Web and Silero load in the content script on a YouTube watch page, the planned capture path delivers frames (31.2 per second, as expected), and the probabilities follow the commentary (87–88% of frames above 0.5 during continuous talking). Model load: 10–50 ms to fetch, 110–210 ms to initialise.

**But in Chrome it rests on YouTube's CSP.** YouTube's policy includes `'unsafe-eval'` (and `require-trusted-types-for 'script'`, which doesn't matter here). On a local page served with `script-src 'self'` and no eval, Chrome's content script fails with `CompileError: WebAssembly.instantiate()`, even when the extension's own CSP declares `'wasm-unsafe-eval'`. The same page with `'wasm-unsafe-eval'` added to the *page's* policy works, so Chrome applies the page's CSP to WebAssembly compilation in content scripts. Firefox runs the model in the content script under the strict policy too.

| Content script on… | Chrome 155 | Firefox 157 |
|---|---|---|
| YouTube (`'unsafe-eval'` allowed) | works | works |
| strict page CSP, no eval | **blocked** | works |
| strict page CSP + `'wasm-unsafe-eval'` | works | – |

The extension's manifest doesn't need `'wasm-unsafe-eval'` for the content-script path in either browser; the default MV3 policies were enough.

**Fallback in an extension context: works.** The same model behind a `runtime.Port`, measured from a content script on the strict-CSP page:

| Where | Round trip per frame (mean / p99) | Inference in the extension context | Init |
|---|---|---|---|
| Chrome service worker | 0.74 / 1.6 ms | 0.42 ms | 180 ms |
| Chrome offscreen document | 0.79 / 2.9 ms | 0.45 ms | 195 ms |
| Firefox background page | 1.04 / 11 ms | 0.41 ms | 130 ms |

Frames are sent as plain arrays (Chrome serialises extension messages as JSON). The round trip is small next to the 32 ms frame.

**Lifetime.** Streaming a frame every 32 ms for 6 minutes (past both Chrome's 30 s idle timeout and its old 5-minute limit per event), with Puppeteer kept off the service worker so DevTools couldn't keep it alive:

| Where | Frames sent / answered | Disconnects | Longest gap between replies |
|---|---|---|---|
| Chrome service worker | 11,249 / 11,249 | 0 | 260 ms |
| Chrome offscreen document | 11,249 / 11,249 | 0 | 35 ms |
| Firefox background page | 11,223 / 11,223 | 0 | 146 ms |

All three stay up while frames flow. The offscreen document was the steadiest and isn't subject to service-worker lifetime rules, so it's the better home for Chrome's fallback, as PLAN.md suggested. It needs the `offscreen` permission with the `WORKERS` reason; the service worker is a workable alternative without the extra permission. Either way the client should reconnect and reset the model state if the port drops.

**Firefox gotcha:** buffers returned by `fetch()` in a Firefox content script belong to the page's compartment, and ORT's `instanceof Uint8Array` check rejects views on them ("Unexpected argument[0]: must be 'path' or 'buffer'"). Copy the bytes into a content-script `Uint8Array` first, or let ORT fetch the `.wasm` itself through `env.wasm.wasmPaths` (which also saves memory, see below).

**Recommendation.** Put inference behind one small interface (`process(frame) → probability`, `reset()`) with two implementations: in the content script, and behind a port in an extension context. Use the content script by default. In Chrome, switch to the offscreen document when WebAssembly fails to compile, which covers other video sites and a future tightening of YouTube's CSP. Firefox only needs the content-script path. The fallback is about 60 lines (`ext/remote.js`, `benchRemote` in `ext/content.js`).

## Spike 2: sped-up speech

Each clip was played at 1x, 2x, 2.5x, 3x and 4x, both time-stretched offline with ffmpeg (`atempo`, pitch kept) and captured from Chrome and Firefox through the extension, and scored against the same clip's 1x trace:

- **speech kept**: share of the frames that 1x calls speech (> 0.6) that are above the threshold at speed;
- **onsets found**: speech starts after at least 1 s of quiet (14 in the clips), found within 1.5 s;
- **false triggers / quiet min**: runs of 2+ frames above the threshold that start in long-quiet media (1x probability < 0.15 for 1 s either side; 2.9 min of media in total), per minute of watching.

Silero v6.2 16 kHz, both browsers' captures (full tables: `results/scores-combined.md`):

| Speed | Threshold | Speech kept (Chrome / Firefox) | Onsets found (Chrome, Firefox) | False triggers / quiet min (Chrome / Firefox) |
|---|---|---|---|---|
| 1x | 0.5 | 98.5% / 98.3% | 13/14, 14/14 | 0 / 0 |
| 2x | 0.5 | 99.8% / 100% | 13/14, 14/14 | 0 / 2.2 |
| 2x | 0.8 | 97.9% / 99.1% | 13/14, 14/14 | 0 / 0 |
| 2.5x | 0.5 | 99.9% / 99.9% | 14/14, 14/14 | 1.8 / 5.5 |
| 2.5x | 0.8 | 98.3% / 98.3% | 14/14, 13/14 | 0 / 0.9 |
| 3x | 0.5 | 99.7% / 99.9% | 14/14, 14/14 | 4.4 / 5.5 |
| 3x | 0.8 | 98.2% / 99.1% | 14/14, 14/14 | 0 / 0 |
| 4x | 0.5 | 100% / 96.8% | 14/14, 14/14 | 11.7 / 10.3 |
| 4x | 0.8 | 97.8% / 92.2% | 14/14, 14/14 | 11.7 / 4.4 |

What this says:

1. **Sped-up speech is recognised.** Commentary at 2x–4x scores as speech almost as reliably as at 1x, in ffmpeg's and both browsers' time-stretching, and onsets are found within one or two frames of where the 1x trace finds them. The plan's main risk didn't materialise.
2. **Sped-up game sound is the problem.** At 1x neither browser triggers in the quiet stretches. Sped up, game sound and music start to look like speech, more so with every step in speed. At 4x the false triggers concentrate in one 20 s gameplay stretch of the mattg clip, which even ffmpeg's 4x scores at 0.3–0.8. Chrome's time-stretching makes this worse than Firefox's or ffmpeg's.
3. **A higher start threshold at gameplay speed fixes it up to 3x**, at little cost: with 0.8 and a minimum of 3 frames above it, neither browser had a single false trigger at 2x–3x, and both kept 98–99% of the speech. At 4x the same rule still leaves 8.8 false triggers per quiet minute in Chrome and 4.4 in Firefox, and even a minimum of 8 frames leaves 1.5 in Chrome (`results/false-runs.txt`).
4. **v6.2 is better than v5.1.2 at speed.** On the same browser-captured audio (replayed under Node), v5.1.2 keeps 85–86% of the speech at 0.8 and 4x against v6.2's 92–98%, and mostly triggers falsely more often at 2.5x and 3x.
5. **The 16 kHz-only export is the same model**: identical probabilities to the full v6.2 file, at 1.3 MB instead of 2.3 MB.

**Starting values for the controller (Phase 2), to be tuned in Phase 3:**

- start threshold 0.5 while at talk speed and 0.8 while at gameplay speed (from 2x up; interpolate in between);
- end threshold 0.35;
- minimum speech duration 3 frames (96 ms) before switching to talk speed;
- default gameplay speed 2.5x; 4x stays available, but the popup should say it can slow down on loud gameplay.

The delay before switching is then about one frame for the model to react, three frames of minimum speech and up to one poll interval: roughly 150–200 ms of wall time, within the 0.4 s target, plus the speed-change lag in spike 4.

Caveats: three clips, 14 onsets and 2.9 minutes of long-quiet media are enough to see the direction, not to set final numbers; the false-trigger counts rest on a handful of events each. Phase 3's test set should include much more gameplay without talking.

**Offline replay matches the browsers.** The 16 kHz audio each browser analysed was saved and replayed through Silero under Node: the probabilities agree with the browser's to within 0.016 (the difference comes from saving the audio as 16-bit). So Phase 3 can tune on recordings offline and trust the result, as long as the recordings are captured in the browser, since the browsers' time-stretching differs from ffmpeg's.

## Spike 3: cost

**CPU.** The whole pipeline (polling, resampling and inference), measured over the 15 clip runs in each browser, takes 15.5–21.7 ms of CPU per second in Chrome and 17.8–23.1 ms in Firefox: about 2% of one core, against the 5% target. Inference alone costs 0.28 ms per frame in Chrome and 0.32 ms in Firefox in a tight loop, and 0.42–0.61 ms inside the live pipeline. Polling itself costs under 0.12 ms per poll. Timers stayed on schedule (p99 poll interval 30–34 ms, nothing lost from the analyser buffer). On a CPU 2.5 times slower the pipeline would still meet the target.

**Memory.** The browser's total PSS on a page with the video loaded, before and after the content script loads the model (median of 3 readings, twice each):

| | Chrome | Firefox |
|---|---|---|
| ORT fetches and compiles the `.wasm` itself (`env.wasm.wasmPaths`) | +100–102 MB | +91–96 MB |
| Content script passes the bytes (`env.wasm.wasmBinary`) | +116–120 MB | +131 MB |
| Capture (`AudioContext`, `AnalyserNode`, polling) | +2 MB | ±2 MB |

The WebAssembly heap is 20 MB; most of the rest is presumably the compiled code of the 14 MB ORT module (not broken down further). So: load the model only while Grindskip is on and a video plays, let ORT fetch the `.wasm` by URL, and release the session when turned off. If 100 MB per tab matters, a reduced-operator ORT build (only the operators Silero uses) is the lever for both memory and package size; consider it in Phase 4.

**Package.** Content script with ORT bundled 121 KB (32 KB zipped; 80 KB minified), ORT `.wasm` 14.2 MB (3.7 MB zipped), model 1.3 MB (1.1 MB zipped): **4.8 MB zipped, 15.7 MB unpacked**. The store download is far under 15 MB; the installed size is just over it.

## Spike 4: Firefox basics (and the same checks in Chrome)

All measured on the synthetic sweep video (its tone rises 100 Hz per media second, so the tone in the captured audio tells which media time is playing), both from a file URL and through Media Source Extensions with separate audio and video SourceBuffers, like YouTube. Both gave the same results.

**Audibility.** What came out of the browser, in dB relative to full scale:

| | Before capture | While captured | Captured and routed to `destination` |
|---|---|---|---|
| Firefox, `captureStream()` | −9 | −9 | −3 (heard twice) |
| Firefox, `mozCaptureStream()` | −9 | **silent** | −9 |
| Chrome, `captureStream()` | −9 | −9 | −6 |

Firefox gained the unprefixed `captureStream()` in version 149 ([MDN compat data](https://github.com/mdn/browser-compat-data/blob/main/api/HTMLMediaElement.json)), and it leaves the video audible. `mozCaptureStream()` still mutes the element. The old code's order (try `captureStream()`, fall back to `mozCaptureStream()`) is right for Firefox 149+, but on older Firefox, including ESR 140, the fallback silences the video unless the captured source is also connected to `AudioContext.destination`.

**Lag after a speed change** (8 changes each between 1x and 2x, 2.5x, 3x, 4x):

| | Captured audio at the new rate after | `currentTime` at the new rate after |
|---|---|---|
| Chrome, file | 30–65 ms | 70–125 ms |
| Chrome, MSE | 40–75 ms | 65–125 ms |
| Firefox, file | 10–35 ms | about 0 |
| Firefox, MSE | 10–35 ms | about 0 |

The roughly 300 ms measured in the old project didn't reproduce. It may depend on the audio device (these runs used a PipeWire null sink; a Bluetooth headset or another OS may buffer more), so the controller should keep following `currentTime` rather than assume a fixed delay. In Chrome, `currentTime` switches about 40 ms *after* the captured audio, so gating on it is safe; in Firefox the two switch together.

**Mute limit** (captured audio / what came out):

| Rate | Chrome | Firefox |
|---|---|---|
| up to 8x | audible / audible | audible / audible |
| 12x, 16x | audible / audible | audible / **silent** |

Neither browser mutes at 4x or 5x any more. The 4x cap stays as a product limit (speech at 4x is barely intelligible, and false slowdowns rise, see spike 2), not a browser one.

## Changes to PLAN.md

Applied to PLAN.md on 2026-10-18, together with two decisions: the model runs in the content script with Chrome's offscreen document as the fallback, and Grindskip supports Firefox 149 and newer. The package-size target is read as the zipped size.

- **Lessons carried over:**
  - Lag: replace "about 300 ms" with the numbers above (under 0.1 s in both browsers here), keeping the advice to follow `currentTime`.
  - 4x limit: browsers no longer mute at 4–5x (Firefox mutes output above 8x, Chrome not up to 16x); 4x is a product choice.
  - Add: Chrome applies the page's CSP to WebAssembly in content scripts; YouTube allows it today via `'unsafe-eval'`.
  - Add: `mozCaptureStream()` mutes the video; use `captureStream()` (Firefox 149+), or route the capture to the output.
  - Add: copy `fetch()` buffers in Firefox content scripts before passing them to ORT, or pass ORT a URL.
- **Architecture:** Silero v6.2 16 kHz export instead of v5; inference behind an interface with a content-script implementation and a port-based fallback in an extension context (Chrome); feed each frame with 64 samples of context.
- **Repository layout:** `assets/silero_vad.onnx` becomes the 16 kHz v6.2 file; `src/vad/` gains the port client, and the extension context gets a small entry point (service worker or offscreen document).
- **Phase 2 controller:** a start threshold that depends on the current speed (0.5 at talk speed, 0.8 at gameplay speed), end threshold 0.35, minimum speech 3 frames; default gameplay speed 2.5x.
- **Phase 3:** record in the browser, not with ffmpeg (their time-stretching differs); weight the test set towards long stretches of gameplay without talking, where the false triggers are.
- **Risks:** "sped-up speech is recognised less well" becomes "sped-up game sound is recognised as speech", with a higher start threshold at gameplay speed and a lower default speed as the fixes. Add per-tab memory (about 100 MB while on).
- **Targets:** say whether 15 MB is the zipped or the unpacked size (4.8 MB / 15.7 MB now).

## Open items

- Recheck the speed-change lag on real output devices (Bluetooth, Windows, macOS) during Phase 3's final check.
- A reduced-operator ORT build, if memory or the unpacked size matters (Phase 4).
