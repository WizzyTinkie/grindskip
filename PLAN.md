# Grindskip: plan

Grindskip is a Chrome and Firefox extension for gameplay videos. It plays the video fast while no one is talking and at normal speed while someone is, so you skip the grind and keep the commentary. Speech is detected with [Silero VAD](https://github.com/snakers4/silero-vad), a small speech-detection model that runs locally in the browser. No audio leaves the computer.

Grindskip grows out of [speech-speed-firefox-advanced](https://github.com/WizzyTinkie/speech-speed-firefox-advanced), a fork of [Speech Speed](https://github.com/ywong137/speech-speed) by Yishan Wong.

## Decisions

| Topic | Decision |
|---|---|
| Name | Grindskip (repo `grindskip`) |
| License | Apache 2.0. The MIT notices of Speech Speed, Silero VAD and ONNX Runtime go in `THIRD_PARTY_NOTICES.md`. |
| Speech detection | Silero VAD only, v6.2 in its 16 kHz-only export (1.3 MB). The rhythm detector from the old repo is dropped. |
| Where the model runs | In the content script. In Chrome, when the page's CSP stops the content script compiling WebAssembly, it falls back to an offscreen document reached over a `runtime.Port`. Firefox needs only the content script. |
| What counts as speech | Any voice: the commentator, in-game dialogue and cutscenes all play at talk speed. |
| Build | npm + esbuild, producing `dist/chrome` and `dist/firefox`. Requires Node.js LTS. |
| Rewind on speech | Included in v1 as an opt-in setting, off by default. |
| Distribution | Publish to the Chrome Web Store and Firefox Add-ons (AMO). |
| Browser versions | Latest Chrome; Firefox 149 and newer (the first with an unprefixed `captureStream()`). |
| Sites | Every site (`<all_urls>`); YouTube is where it's tested and tuned. |
| Data collection | None. The Firefox manifest declares it (`data_collection_permissions: none`). |

## Lessons carried over from the old repo

- **Audio lag after speed changes:** after a `playbackRate` change, the captured audio keeps the old rate for a moment. The old repo measured about 300 ms in Chrome; Phase 0 measured 30–75 ms in Chrome and 10–35 ms in Firefox on a PipeWire null sink, so it likely depends on the output device. Don't assume a fixed delay: the video's `currentTime` shows when the switch has happened (in Chrome about 40 ms after the audio, in Firefox at the same time).
- **4x limit:** a product limit, not a browser one. Current browsers don't mute at 4–5x any more (Firefox mutes the output above 8x, Chrome not even at 16x), but speech at 4x is barely intelligible and sped-up game sound triggers false speech more often, so the gameplay speed stops at 4x.
- **Trusted Types:** YouTube enforces Trusted Types, so in page context the overlay must be built with DOM calls, never `innerHTML`.
- **Proven capture path:** capture via `captureStream()` into an `AnalyserNode` polled every 30 ms works under YouTube's Content Security Policy. An AudioWorklet loaded from a blob URL was blocked there in the original project. Don't use `mozCaptureStream()`: it mutes the video unless the capture is also routed to the speakers.
- **WebAssembly in content scripts:** Chrome applies the page's CSP to WebAssembly compiled in a content script, whatever the extension's own CSP says. YouTube allows it today only through `'unsafe-eval'`; on stricter pages the content script can't load the model. Firefox isn't affected.
- **Firefox content scripts and ORT:** buffers from `fetch()` belong to the page's compartment, and ONNX Runtime's `instanceof Uint8Array` check rejects them. Let ORT fetch the `.wasm` by URL (`env.wasm.wasmPaths`), which also uses 20–40 MB less memory, and copy the model bytes into a content-script `Uint8Array`.
- **Test on real videos:** synthetic test audio misled the old rhythm detector. Tuning must use real gameplay videos with known speech times; YouTube's auto-generated captions give word timings.
- **Firefox reloads:** Firefox keeps a temporary add-on's old code until you click Reload in `about:debugging`.

## Architecture

```
video ─ captureStream ─ AnalyserNode (polled every 30 ms)
      → resample to 16 kHz (windowed sinc) → 512-sample frames (32 ms), each with the previous 64 samples as context
      → Silero VAD v6.2 (ONNX Runtime Web, WebAssembly, 1 thread) → speech probability per frame
          in the content script, or in Chrome's offscreen document over a runtime.Port when the page's CSP blocks WebAssembly
      → controller (thresholds, wait, speeds, optional rewind) → video.playbackRate
```

Phase 0's measurements behind these choices are in [spikes/phase0/REPORT.md](spikes/phase0/REPORT.md).

## Repository layout (target)

```
src/
  content/      video.js, capture.js, speed.js, saved.js (time saved), overlay.js, recorder.js (debug recording), main.js
  vad/          silero.js (model and per-stream state), resample.js, load.js (loads it in an extension context), remote.js (port client for the fallback)
  background/   background.js (adds the tabs' time saved to the total; in Chrome also opens the offscreen document)
  offscreen/    offscreen.html, offscreen.js (Chrome only: serves the model over a port)
  controller/   controller.js (pure decision logic)
  popup/        popup.html, popup.js, popup.css
  shared/       settings.js (defaults, storage, migration), stats.js (the total time saved), messages.js
assets/         icons/ (icon.svg and its PNGs), silero_vad.onnx (v6.2, 16 kHz export)
manifest/       base.json, chrome.json, firefox.json
scripts/        build.mjs (esbuild, copies wasm and model, writes dist/<browser>), manifest.mjs (merges the manifests)
test/           unit tests (Node's built-in test runner)
eval/           evaluation harness: test set, browser recordings, offline replay and sweep (own package.json)
spikes/phase0/  Phase 0 spike code, measurements and report (not shipped)
```

## Phases

### Phase 0: Spikes (answer the risky questions first) — done

Result: go. See [spikes/phase0/REPORT.md](spikes/phase0/REPORT.md). In short: the model runs in the content script on YouTube in both browsers, with an offscreen-document fallback in Chrome; sped-up commentary is still recognised, but sped-up game sound is mistaken for speech more often, so gameplay speed needs a higher start threshold; the whole pipeline costs about 2% of one core and about 100 MB per tab; the package is 4.8 MB zipped.

1. **Where the model runs.** First try ONNX Runtime Web directly in the content script on YouTube, in Chrome and Firefox. If the page blocks WebAssembly there, run it in an extension page and send the audio frames over a message port: an offscreen document in Chrome, the background page in Firefox.
2. **Sped-up speech.** Compare Silero's speech probabilities on real commentary at 1x, 2x, 2.5x and 3x, both time-stretched with ffmpeg and captured in the browser. This decides whether we need a different threshold at gameplay speed.
3. **Cost.** Time per 32 ms frame in each browser, memory use, and the size of the packaged extension.
4. **Firefox basics.** Does the video stay audible with `mozCaptureStream()`? How long is the audio lag after a speed change, and where does the mute limit start?

Exit: the architecture is chosen, starting thresholds are known, and there's a go/no-go decision.

### Phase 1: Scaffold — done

Result: `npm run build` produces both extensions; they load in Chrome for Testing 155 and Firefox 157, and in Chrome the model and the `.wasm` can be fetched from a web page. The source files are empty entry points for Phase 2. Settled along the way:

- The content script and the web-accessible resources match `<all_urls>`, so Grindskip works on any site with a `<video>`. In Chrome, sites whose CSP blocks WebAssembly in the content script are what the offscreen fallback is for.
- The Firefox add-on ID is `grindskip@wizzytinkie.github.io`, and the manifest declares `data_collection_permissions: none`, which AMO requires of new add-ons.
- Chrome's offscreen document needs a service worker to open it (`src/background/`).
- `assets/silero_vad.onnx` is committed; its source commit and SHA-256 are in `THIRD_PARTY_NOTICES.md`, and a test checks the hash.

- `package.json` with `onnxruntime-web` as a dependency, and esbuild, `web-ext` and ESLint as development dependencies.
- `npm run build` writes `dist/chrome` and `dist/firefox` from `manifest/base.json` plus per-browser additions (Chrome: the `offscreen` permission; Firefox: a fixed add-on ID in `browser_specific_settings.gecko.id` and `strict_min_version` 149). The ORT `.wasm` and the model are web-accessible resources. `npm run watch` rebuilds on save.
- `npm test` runs unit tests with Node's built-in test runner.
- `THIRD_PARTY_NOTICES.md`: Speech Speed (MIT, Yishan Wong), Silero VAD (MIT, Silero Team), ONNX Runtime (MIT, Microsoft).
- `.gitignore`: `node_modules/`, `dist/`, `.idea/`.

### Phase 2: Core — done

Result: Grindskip works end to end in Chrome for Testing 155 and Firefox 157, on YouTube (including moving to the next video in the same player) and on a local page with a strict CSP, where Chrome runs the model in the offscreen document. `npm test` covers the controller (rules, rewind safeguards, and a closed-loop replay on Phase 0's recorded traces), the settings, the resampler, Silero under Node, the speed control and the port client. Settled along the way:

- Chrome's default policy for extension pages doesn't allow WebAssembly, so `manifest/chrome.json` adds `'wasm-unsafe-eval'` to `content_security_policy.extension_pages` for the offscreen document. (Phase 0's spike build had it; the content script doesn't need it.)
- Grindskip is off after installing; the popup turns it on for every site. The overlay is off by default and has its own checkbox.
- Muted videos are left alone (no model, no capture), which also skips YouTube's hover previews.
- After a seek, a new video and at the start, the controller begins in the wait state, so the first words aren't rushed before the model has heard anything.
- When the user changes the speed (the player's menu, another extension), Grindskip stops changing it on that video until the popup's *Change the speed again* or the next video. Speed changes in the 1.5 s after a new source loads are the player's own (YouTube restores its saved speed) and are overridden.
- One Silero model serves several streams with their own state, its runs queued; the offscreen document keeps one model for all tabs and closes itself after 30 s without a tab.
- Turning Grindskip off releases the model's session, but not ONNX Runtime's compiled WebAssembly, which ORT can't unload: that stays in the tab until it reloads.
- The content script runs in the top frame only, so videos embedded through an iframe (a YouTube embed on another site) aren't handled yet.

1. **`video.js`:** finds the largest video, re-attaches when YouTube swaps it, and tracks pause, seek and buffering. Ported from the old repo.
2. **`capture.js` and `resample.js`:** capture with `captureStream()`, a resampler to 16 kHz that low-passes as it goes (any input rate; 48 kHz in practice), and 512-sample framing. Start from `spikes/phase0/lib/resample.js`.
3. **`silero.js`:** the Silero v6.2 session. It feeds each frame with the previous 64 samples as context, carries the recurrent state between frames and resets it on seek or re-attach. Start from `spikes/phase0/lib/silero.js`. Load it only while Grindskip is on and a video plays, and release it when turned off.
4. **`remote.js` and the offscreen document:** the same `process(frame)` / `reset()` interface over a `runtime.Port`, used in Chrome when the content script can't compile WebAssembly. One session in the offscreen document, with state per port; the client reconnects and resets if the port drops. Start from `spikes/phase0/ext/remote.js`.
5. **`controller.js`:** pure logic with no browser APIs, unit-tested on recorded probability traces. It turns probabilities and time into a state and a speed:
   - a start threshold that depends on the current speed (starting values: 0.5 at talk speed, 0.8 from 2x up) and a lower end threshold (0.35);
   - a minimum speech duration before switching (starting value: 3 frames, 96 ms);
   - the wait before speeding up;
   - an instant speed switch;
   - rewind on speech (opt-in, off by default), with safeguards: only after a few seconds at gameplay speed, at most about 1.5 s back, never right after a manual seek.
6. **`speed.js`:** applies `playbackRate`, caps it at 4x, restores 1x when turned off, and backs off when the user changes the speed themselves.
7. **UI:**
   - **Popup:** on/off, the current state and speed, speed while talking, speed while playing (default 2.5x; above 3x, note that loud gameplay may slow it down), wait before speeding up, sensitivity, and rewind on speech.
   - **Overlay:** speech probability meter and state, built with DOM calls.
   - **Settings:** saved in `storage.local`, with defaults and migration.

### Phase 3: Evaluation and tuning — done, except the check on Windows and macOS

Result: see [eval/REPORT.md](eval/REPORT.md). On the speech the model hears, at the default 2.5x, the controller meets the targets in both browsers: 96.8% (Chrome) and 95.7% (Firefox) of the commentary at talk speed, 98% of the rest at gameplay speed, no false slowdowns, a median delay of 0.10–0.26 s and 1.5% of a core for inference. With rewind on it reaches 98.7% and 97.4%, short of 99%. Against all of the auto-captions the share at talk speed is 92–93%, because some caption words in the gameplay stretches never register with the model at all. Settled along the way:

- The test set is five sections of Risen Let's Plays, 13 minutes in all (`eval/lib/clips.mjs`). The RISEN video is [Morgannin's Part 1](https://www.youtube.com/watch?v=BFG1Q7zpNtE), whose music intro lasts 16 s rather than 60. A five-minute low-talk stretch of [another Morgannin video](https://www.youtube.com/watch?v=v4w8WzKm0Mg&t=390) covers long gameplay with few remarks.
- Labels are the auto-captions as they are, without correction by hand; `[Music]` and similar tags don't count.
- Recordings are made through the extension itself: an evaluation build (`node scripts/build.mjs --eval`) adds a hook to drive the content script from the page, which also gets around Firefox's WebDriver BiDi not opening extension pages.
- New defaults from the sweep: start threshold 0.9 at gameplay speed (was 0.8) with 2 frames of minimum speech (was 3). At 4x this cuts false slowdowns from 8 to 3, and it is no worse at 2–3x. Rewind goes 0.5 s further back than the detected onset (was 0.25 s). The talk-speed start threshold (0.5) and the end threshold (0.35) made no measurable difference and stay.
- The popup's debug recording saves to a file through a link in the page, which worked in both browsers.
- The popup shows the time saved, on the current video and in total, compared with 1x: media time played at speed r saves (1 − 1/r) of it, a rewind costs the media it jumps back over, and seeks and speeds set by the user don't count. The tabs report every 10 s to the background script, which alone writes the total to `storage.local`, so tabs can't overwrite each other's additions; Firefox now has an event page for this.
- Speeding up from exactly 1x clicked in both browsers: at 1x they skip their time-stretcher, and starting it again on the switch is audible. Talk speed 1x is therefore played as 1.001x (`NORMAL_RATE` in `speed.js`), which keeps the time-stretcher running, so a speed-up only changes its rate. Choosing exactly 1x in the player's menu still doesn't count as a speed change by the user.


- **Test set:** 3–5 real segments, including the RISEN video (music intro, then continuous commentary) and long stretches of gameplay with little talking, where the false slowdowns happen. Speech times come from the auto-generated captions, corrected by hand where needed. Phase 0's three clips (`spikes/phase0/lib/clips.mjs`) are a starting point.
- **Debug recording:** started by the user, it saves the analysed 16 kHz audio, probabilities, speeds and video times to a file.
- **Offline replay:** the same controller and model run under Node on the recordings, for fast threshold sweeps. Record at each gameplay speed in the browser: Chrome's and Firefox's time-stretching differ from ffmpeg's and from each other, so ffmpeg copies are only a rough guide. Phase 0 showed that Node replay matches the browser's probabilities on the same audio.
- **Metrics:**
  - commentary heard at talk speed (%);
  - delay before switching to talk speed;
  - non-commentary played at gameplay speed (%);
  - false slowdowns per minute;
  - CPU per frame.
- **Final check:** in Chrome and Firefox on the real videos, including the speed-change lag on real output devices (Bluetooth, Windows, macOS). Done on Linux through a Bluetooth headset, with 1.001x: no audible difference. Windows and macOS are still to do.

### Phase 4: Polish and release

- Keyboard shortcut to toggle — done: Alt+Shift+G (Ctrl+Shift+G is *find previous* in both browsers). KeePassXC-Browser suggests the same key for its password generator, and in Firefox the two clash; the README says where to set another. It's a browser command handled by the background script, which flips the setting in storage. The toolbar icon is green while Grindskip is on and gray while it's off, so the shortcut's effect can be seen (a badge was tried first, but a green "on" on the green icon looked bad, and the browsers draw badges as they like); the popup's switch shows the shortcut as set in the browser.
- Icons — done: a green speech bubble with white fast-forward arrows (the talking kept, the rest skipped), in the popup's green. `assets/icons/icon.svg` is the source; `node scripts/icons.mjs` renders the 16, 32, 48 and 128 px PNGs with `rsvg-convert`, plus gray 16 and 32 px ones for the toolbar while Grindskip is off, and they're committed so the build needs no SVG renderer.
- Store screenshots and descriptions.
- README with credits, and the website text.
- Privacy statement: no data collected, nothing leaves the device.
- Firefox Add-ons: fixed add-on ID; the source code and build instructions are submitted with each release, because the code is bundled.
- Chrome Web Store: developer account (one-time registration fee); justify the `offscreen` permission (reason `WORKERS`) and the access to all sites (any site's video can be sped up), which also means a longer review.
- Optional: a reduced-operator ONNX Runtime build (only the operators Silero uses), if the installed size or the memory per tab needs to come down.

### Phase 5 (optional): Fine-tuning

If music or sound effects still trigger speech, fine-tune Silero on labelled gameplay audio with the `tuning` scripts in the Silero VAD repo. They need PyTorch and speech start and end times accurate to about 30 ms.

### Later: earlier speech detection

Grindskip hears speech only once it plays, so the start of each remark is heard at gameplay speed. In Phase 3 the switch came a median 0.10 s (Chrome) and 0.26 s (Firefox) after the onset: 0.25–0.65 s of media at 2.5x, the first syllable or word. Rewind makes up for it, but the jump is audible.

Where the time goes, measured on the Phase 3 recordings at 2.5x (about 9 onsets per browser after at least 1 s without speech, from the onset the model hears at 1x): the probability reaches 0.5 after a median 10 ms (Chrome) and 53 ms (Firefox), 0.9 after 39 and 83 ms, and two frames at 0.9 after 69 and 119 ms. The speed change then takes 10–75 ms to reach the speakers. Firefox is about 45 ms behind at every step, which looks like its capture running later rather than the model.

1. **One frame instead of two — done.** Below 3x, one frame above the threshold is enough (`minSpeechFrames` and `minSpeechFramesFast` in `controller.js`). At 2.5x, speech at talk speed goes from 92.8 to 93.4% (Chrome) and 91.9 to 92.3% (Firefox), or 96.8 to 97.5% and 95.7 to 96.2% of the speech the model hears, with no false slowdowns. From 3x up it stays at two: one frame gave 6 false slowdowns instead of 2 at 4x, and 1 instead of 0 at 3x.
2. **Other ways to react sooner, all small.** A lower start threshold (about 30 ms, but false slowdowns rise below 0.85 at 3–4x), a decision every 16 ms from two model streams half a frame apart (16 ms, twice the inference), an AudioWorklet instead of the 30 ms analyser poll (15 ms, if YouTube's CSP allows it). Even together they leave a syllable at gameplay speed.
3. **Look ahead: the way to make rewind unnecessary.** Analyse the audio before it plays and slow down at the onset, or just before it. YouTube and most players load audio seconds ahead through Media Source Extensions: a script in the page's world (`world: "MAIN"`) could copy the audio appended to the `SourceBuffer`, Grindskip would unpack it (WebM/Opus or MP4/AAC) and decode it with WebCodecs' `AudioDecoder` (Firefox 130+), and run Silero on it. The model would hear 1x audio, so the 0.9 threshold for sped-up game sound and the 4x false slowdowns could go too. The live capture stays as the fallback (plain video files, encrypted media). The spike says go ([spikes/lookahead/REPORT.md](spikes/lookahead/REPORT.md)): YouTube appends Opus in WebM from the page in both browsers, 25–44 s ahead; a 150-line demuxer and WebCodecs decode it, and Silero hears the same in it as in the captured audio; the replay keeps as much speech as rewind at 2–2.5x and more at 3–4x, with no jump back and as few false slowdowns, by requiring 0.26 s of speech and slowing down 0.3 s before it. **Implemented** (`src/page/hook.js`, `src/lookahead/`): a `world: "MAIN"` content script at `document_start` wraps `URL.createObjectURL`, `addSourceBuffer`, `appendBuffer` and `abort`, keeps each audio buffer's init segment and last 4 MB of appends, and passes the followed video's audio (matched by its blob URL) to the content script over a `MessagePort`. There it's demuxed, decoded with WebCodecs, resampled and run through its own Silero stream into a timeline by media time; a schedule with the rules above sets the speed every 30 ms, and the live capture is off. Where look-ahead isn't possible (no Media Source, AAC, a decoding error), the live path runs as before. Checked in Chrome and Firefox on YouTube (look-ahead on, 25–43 s ahead, gameplay at 2.5x) and on a local Media Source page with the eval clips: every onset the model hears slowed down 0.18–0.35 s of media before it, against 0.15–0.39 s after it when listening live, through seeks too, and with the model in Chrome's offscreen document under a strict CSP. Learned on the way: Chrome's `AudioDecoder` carries its output timestamps on from where it was whatever the input's, so the decoder is reset where the input jumps. Still open: the debug recording in look-ahead mode (it records nothing yet), and checking that YouTube's ads and quality changes keep it in sync. A script in the page's world also means a closer store review. **Rewind removed** (2026-10-24): with look-ahead slowing down before speech where the player streams its audio, the rewind setting is gone; the live fallback slows down a moment after the onset, as without rewind before. **Look ahead can be turned off** (2026-10-24): it takes more CPU than listening live (decoding and analysing the audio as fast as the player loads it), so the popup has an *Analyze audio ahead* setting, on by default; off, the content script closes the feed and listens live. The page hook keeps running either way, as it has to be in place before the page's scripts. **AAC in MP4** (2026-10-24): the spike ([spikes/lookahead-aac/REPORT.md](spikes/lookahead-aac/REPORT.md)) found hls.js, Shaka (HLS), dash.js, video.js, TED, YouTube's AAC streams, and Twitch and Kick in Firefox appending AAC in fragmented MP4 from the page; both browsers' WebCodecs decode it at Opus's cost, and Silero hears the same in it as in Opus (99.6% agreement on the same video). `lookahead/fmp4.js` demuxes it; the hook now follows buffers by their codecs (Twitch and Kick label theirs `video/mp4;codecs="mp4a.40.2"`, and some Twitch streams put video and audio in one buffer, `avc1.4D402A,mp4a.40.2`, whose video the demuxer skips), passes each append on with its `timestampOffset` (read after the append in `sequence` mode, where the browser sets it, as Shaka's HLS does) and append window, and reports `changeType`. The analysis picks the demuxer by the init segment, resamples from the decoder's output rate (implicit SBR doubles it), and feeds the decoder a continuous timeline of its own, keeping the small gaps and overlaps between segments (up to 22 ms each) as a shift back to media time: Chrome's decoder counts on from its first input, so they would otherwise add up. Checked in the extension in Chrome and Firefox: look-ahead on hls.js (TS and fMP4), Shaka HLS, dash.js, video.js, TED and Twitch live (Firefox), through seeks. Learned on the way: Shaka changes `playbackRate` itself after a seek, which Grindskip takes for the user's change.

## Targets (measured on the test set)

| Measure | Target | Phase 3, at 2.5x (Chrome / Firefox) |
|---|---|---|
| Commentary heard at talk speed | ≥ 95% (≥ 99% with rewind on) | 96.8 / 95.7% (98.7 / 97.4% with rewind) of the speech the model hears; 92.8 / 91.9% of all captioned speech |
| Non-commentary played at gameplay speed | ≥ 90% | 97.9 / 97.7% |
| Median delay before switching to talk speed | ≤ 0.4 s | 0.10 / 0.26 s |
| CPU | ≤ 5% of one core | inference 1.4 / 1.5%; about 2% with capture (Phase 0) |
| Package size | ≤ 15 MB zipped (4.8 MB in Phase 0; 15.7 MB unpacked) |
| Browsers | Latest Chrome and Firefox, on YouTube |

## Risks

- **Sped-up game sound is recognised as speech.** Phase 0 found that sped-up commentary is still recognised, but game sound and music look more like speech the faster they play, especially at 4x and in Chrome. Fixes: a higher start threshold at gameplay speed (0.9 since Phase 3), a minimum speech duration, and a default gameplay speed of 2.5x. Phase 3 found no false slowdowns at 2.5x and 3x on its test set, but 1–2 per browser in 2 minutes of quiet media at 4x.
- **YouTube tightens its CSP.** Chrome would then refuse WebAssembly in the content script; the offscreen-document fallback covers it.
- **Memory.** The model costs about 100 MB per tab while it's loaded, mostly ONNX Runtime's compiled code. Load it only while on; a reduced-operator ORT build is the lever if needed.
- **Vocals in game music count as speech.** Fine-tuning can help.
- **Running on every site.** The content script loads in every page, so it must stay idle (no model, no capture) until a video plays with Grindskip on. Any page can also tell that Grindskip is installed by fetching its web-accessible files; Chrome's `use_dynamic_url` could hide them, if ORT still finds the `.wasm` that way.
- **Store review of bundled code.** Keep the bundle unminified and the build reproducible. `web-ext lint` warns about a dynamic `import()` in ONNX Runtime's code (`UNSAFE_VAR_ASSIGNMENT`); it loads ORT's WebAssembly glue, which the bundle already contains, so it never runs. Explain this in the AMO submission notes.
