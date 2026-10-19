# Look-ahead spike

Date: 2026-10-19. The question: can Grindskip analyse a video's audio before it plays, so that it slows down at the start of speech instead of a little after it, and rewind becomes unnecessary? Result: **go**. It works on YouTube in both browsers, and the replay says it would beat today's detection with rewind, without jumping back.

## 1. What it would gain (`replay.mjs`)

The 1x recordings from Phase 3 are what look-ahead would analyse: the audio at normal speed, by media time. The replay builds the speech schedule from them with the talk-speed rules everywhere (start 0.5, end 0.35, the 1.5 s wait), then plays each clip by that schedule, slowing down a little before each onset. A speed change still reaches the audio two frames late. It's scored like `eval/run.mjs`, against the same caption labels.

Knowing the audio in advance makes a longer minimum free: speech can be required to last 8 frames (0.26 s) and still start at the first of them. That filters out the short sounds the 1x model takes for speech (at 1:21.8 and 1:50.4 in bumpy, and 8:21.6 in sparse), which gave 2–3 false slowdowns with a 1-frame minimum.

Speech at talk speed (all captions / speech the model hears at 1x), gameplay played at gameplay speed, false slowdowns; Chrome | Firefox:

| Gameplay speed | Live (today) | Live, rewind on | Look-ahead, 8 frames, 0.3 s early |
|---|---|---|---|
| 2x | 94.0 / 98.0%, 97.2%, 2 \| 93.2 / 97.2%, 97.4%, 1 | 95.3 / 99.4%, 97.0%, 2 \| 94.8 / 98.8%, 97.4%, 1 | 95.2 / 99.4%, 97.5%, 1 \| 95.1 / 99.2%, 97.9%, 0 |
| 2.5x | 93.4 / 97.5%, 97.8%, 0 \| 92.3 / 96.2%, 97.7%, 0 | 94.9 / 99.0%, 97.8%, 0 \| 93.7 / 97.6%, 97.8%, 0 | 95.2 / 99.2%, 97.6%, 1 \| 94.9 / 98.9%, 97.9%, 0 |
| 3x | 91.9 / 95.8%, 97.8%, 0 \| 91.6 / 95.5%, 97.7%, 0 | 94.2 / 98.3%, 97.8%, 0 \| 93.7 / 97.7%, 97.8%, 0 | 95.0 / 99.1%, 97.6%, 1 \| 94.7 / 98.7%, 98.0%, 0 |
| 4x | 91.8 / 95.8%, 97.8%, 2 \| 88.6 / 92.6%, 98.0%, 1 | 93.1 / 97.1%, 97.7%, 2 \| 89.8 / 93.9%, 98.0%, 1 | 94.6 / 98.7%, 97.7%, 1 \| 94.4 / 98.4%, 98.0%, 0 |

Look-ahead keeps as much speech as rewind at 2–2.5x and more at 3–4x, the same in both browsers (Firefox's capture lag no longer matters), with as few false slowdowns. Switching 0.2 s early instead of 0.3 s costs about 0.3 points. The remaining few percent of the speech the model hears are mostly caption words that start before the model hears anything.

## 2. Can a page script see the audio? (`probe-youtube.mjs`)

A script run in the page's world before YouTube's own (Puppeteer's `evaluateOnNewDocument`, as a `world: "MAIN"` content script would be) wraps `MediaSource.addSourceBuffer` and `SourceBuffer.appendBuffer`, and plays [BFG1Q7zpNtE](https://www.youtube.com/watch?v=BFG1Q7zpNtE) for 20 s into a null sink.

| | Chrome for Testing 155 | Firefox 158 |
|---|---|---|
| Media Source in the page (not a worker) | yes, one | yes, one |
| Audio buffer | `audio/webm; codecs="opus"` | `audio/webm; codecs="opus"` |
| Audio appends in 20 s | 519 (1.07 MB) | 756 (1.07 MB) |
| Audio buffered ahead of playback | 25–44 s | 25–44 s |
| `timestampOffset` | 0 | 0 |

Chrome supports Media Source in workers, but YouTube doesn't use it. Every append was visible.

## 3. Can it be decoded and analysed? (`webm.js`, `decode.mjs`)

`webm.js` is a streaming WebM demuxer (about 150 lines): the Opus setup from the init segment (266 bytes), then each 20 ms frame with its timestamp, across appends that split elements anywhere. YouTube's blocks are unlaced. The first 20 s of the captured appends were decoded with WebCodecs' `AudioDecoder` in the browser, and Silero ran on the result under Node, compared with the Phase 3 1x recording of the same video (the risen clip):

| | Chrome | Firefox |
|---|---|---|
| `AudioDecoder` supports the config | yes | yes |
| Demux + decode of 20 s | 26 + 90 ms | 13 + 125 ms |
| Silero, mean difference from the recording | 0.005 | 0.004 |
| Agree on speech (> 0.5) | 100% | 99.8% |
| Timestamps vs the recording's media times | 12 ms | 20 ms |

So the decoded audio is as good as the captured audio for Silero, and its timestamps are the media times. Cost per second of media: about 6 ms to demux and decode plus 11 ms for Silero (0.35 ms per 32 ms frame), so at 2.5x about 4% of a core, against about 2% for today's capture and inference. On YouTube the capture could stop entirely.

## Open for the implementation

Since implemented, as described in PLAN.md (Later: earlier speech detection); `check-youtube.mjs` and `check-local.mjs` check it in the extension. What was open:

- **Extension wiring:** a `world: "MAIN"` content script at `document_start` with the hooks (check that it runs before YouTube's scripts in both browsers, as Puppeteer's did), handing copies of the audio appends to the isolated content script (a `CustomEvent` or `postMessage`). The page can see and spoof these messages; the worst it can do is mislead Grindskip on that page. Store reviewers will look at the main-world script.
- **Which video:** map each `MediaSource` to its `<video>` (hook `URL.createObjectURL`, match `currentSrc`), so ads and hover previews don't mix in.
- **Keeping in sync:** seeks (new ranges appended, sometimes twice), `SourceBuffer.remove`, a new init segment when the audio quality changes, ads. Reset the model state where timestamps jump; keep the schedule by media time.
- **AAC:** other videos or browsers may get `audio/mp4; codecs="mp4a.40.2"`, which needs an fMP4 demuxer. Until then, the live capture is the fallback, as for plain video files, encrypted media, and sites that append from a worker.
- **The controller:** follow `currentTime` (every poll or `requestVideoFrameCallback`) against the schedule, switch `lead` early, and turn rewind off where look-ahead works.
