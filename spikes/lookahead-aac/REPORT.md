# Look-ahead spike: AAC in fragmented MP4

Date: 2026-10-24. The question: look-ahead works only where the player appends Opus in WebM (YouTube in Chrome and Firefox). Can it also work where the player appends AAC in fragmented MP4, the usual format of HLS and DASH players? And what does the implementation have to handle? Result: **go**. Both browsers decode every AAC stream seen, Silero hears the same in AAC as in Opus, and a 300-line demuxer is enough. The work is mostly in the hook and in the timestamps, not in the codec.

Chrome for Testing 155 and Firefox 158 on Linux, headless, through Puppeteer.

## 1. Can WebCodecs decode it? (`caps.mjs`)

`AudioDecoder.isConfigSupported` with a real AudioSpecificConfig for each profile:

| | Chrome 155 | Firefox 158 |
|---|---|---|
| AAC-LC (`mp4a.40.2`) 44.1/48 kHz, stereo and 5.1 | yes | yes |
| HE-AAC v1 (`mp4a.40.5`), v2 (`mp4a.40.29`) | yes | yes |
| Opus | yes | yes |
| MP3 | yes | yes |
| AC-3, E-AC-3 | no | no |

Every stream captured below did decode, in both browsers (section 3). Firefox decodes AAC through the system's decoder (ffmpeg on Linux), so a Firefox build without one won't decode it. `isConfigSupported` tells, and the live capture remains the fallback.

## 2. What players append (`probe.mjs`)

The hooks of `probe-site.mjs`, and also `timestampOffset` (before and after each append), `mode`, `appendWindow*`, `changeType`, `remove`, `abort` and DRM requests. The four common player libraries on public test streams (`pages/player.html` loads them from jsdelivr), YouTube with Opus hidden from the player (`MediaSource.isTypeSupported` and `mediaCapabilities` say no to Opus, so it picks its AAC stream), and some sites. Played for 15 s:

| Target | Audio SourceBuffer | Appends start with | `timestampOffset` | Mode | Ahead |
|---|---|---|---|---|---|
| hls.js 1.5, TS stream (transmuxed) | `audio/mp4;codecs=mp4a.40.2`, then `changeType` to `mp4a.40.5` (Chrome) | `ftyp,moov` / `moof,mdat` | 0 | segments | 85 s |
| hls.js 1.5, fMP4 stream (Apple) | `audio/mp4;codecs=mp4a.40.2` | `ftyp,moov` / `moof,mdat` | 0 | segments | 39–45 s |
| Shaka 4.12, DASH | `audio/webm; codecs="opus"` (supported already) | EBML / Cluster | 0 | segments | 13 s |
| Shaka 4.12, HLS fMP4 | `audio/mp4; codecs="mp4a.40.2"` | `ftyp,moov` / `styp,sidx,moof,mdat` | 0, then 0.0213 (Chrome) | **sequence** | 13 s |
| dash.js 4.7 | `audio/mp4;codecs="mp4a.40.5"` | `ftyp,moov` / `styp,sidx,moof,mdat` | 0 | segments | 65 s |
| video.js 8 (VHS), TS stream | `audio/mp4;codecs="mp4a.40.5"` (the config inside says AAC-LC at 22 kHz) | `ftyp,moov,moof,mdat` in one append | **−10** | segments | 45 s |
| YouTube, AAC | `audio/mp4; codecs="mp4a.40.2"` | `ftyp,moov` / `moof,mdat`, then pieces that split boxes anywhere | 0 | segments | 40 s |
| TED (hls.js) | `audio/mp4;codecs=mp4a.40.2` | `ftyp,moov` / `moof,mdat` | 0, −0.0176, then **−95440.165** | segments | 439 s |
| Twitch live, Firefox | **`video/mp4;codecs="mp4a.40.2"`** | `ftyp,moov,moof,mdat` / `moof,mdat,moof,mdat` | 0 | segments | 1.2 s |
| Kick live, Firefox | **`video/mp4;codecs="mp4a.40.2"`** | the same | 0 | segments | 1.6 s |
| Twitch, Kick in Chrome | Media Source in a worker (`srcObject` is a `MediaSourceHandle`): no appends to see | | | | |

None used DRM (Kick asks which key systems exist, but sets no keys). None put audio and video in one SourceBuffer. Vimeo and Dailymotion weren't reachable from this machine (its DNS blocks them), and ČT24 never started playing headless. They are still open.

## 3. Demuxing and decoding (`fmp4.js`, `decode.mjs`)

`fmp4.js` is a streaming fMP4 demuxer, about 300 lines with the same interface as `src/lookahead/webm.js`:

- From the `moov`: the track (`hdlr` `soun`), the timescale, `esds` giving an AudioSpecificConfig and the codec string, `dOps` converted to OpusHead, `enca` flagged as encrypted, the edit list, and the `trex` defaults.
- From each `moof` + `mdat`: the samples, using `tfhd`, `tfdt` and `trun`.
- Appends may split boxes anywhere, so a `moof` is held until its `mdat` is complete.

On ffmpeg's fMP4 output (AAC-LC, Opus in MP4, and AAC muxed with H.264) it gives exactly ffprobe's packets, timestamps and bytes, whether the bytes come in one piece, 1000-byte chunks or 7-byte chunks.

Decoding the captured appends with `AudioDecoder`, configured from the init segment:

| | Chrome | Firefox |
|---|---|---|
| AAC streams decoded / captured | 7 / 7 | 9 / 9 |
| Errors | none | none |
| Frames out / in | all (hls.js TS: one fewer) | all (hls.js TS: one fewer) |
| Demux, per minute of media | 1–3 ms | 0–4 ms |
| Decode, per second of media | 1.5–3.8 ms (Opus: 2.3–2.8) | 1.5–2.4 ms (Opus: 3.2–3.3) |

AAC costs the same to decode as Opus. Two details matter for the implementation:

- **Implicit SBR:** video.js's stream declares AAC-LC at 22,050 Hz (and labels the buffer `mp4a.40.5`). The decoder outputs 44,100 Hz. So the resampler must be set from `AudioData.sampleRate`, not from the config.
- **Input jumps:** at TED's offset jump (input timestamps from 189 s to 95,629 s), Chrome's output timestamps carry on from where they were while Firefox's follow the input. This is what `analysis.js` already handles by resetting the decoder where the input jumps.

## 4. Does Silero hear the same? (`compare.mjs`)

YouTube's AAC (44.1 kHz) and Opus (48 kHz) streams of BFG1Q7zpNtE (the risen clip), each decoded in the browser, then run through Silero at 1x under Node and compared by media time:

| | Chrome | Firefox |
|---|---|---|
| Media compared | 59.4 s, 1842 frames | the same |
| Mean difference in speech probability | 0.0055 | 0.0055 |
| Agree on speech (> 0.5) | 99.6% | 99.6% |
| Speech onsets: AAC / Opus | 18 / 18 | 18 / 18 |
| Onsets within 32 ms / 64 ms of each other | 17 / 18 | 17 / 18 |
| Best alignment shift | 18 ms | 18 ms |

The same as the 0.004–0.005 the Opus spike measured between decoded and captured audio. Chrome's and Firefox's AAC decodes give identical probabilities.

## What the implementation needs

- **Hook, which buffers:** decide by the codecs, not the type. Twitch and Kick in Firefox append AAC to a `video/mp4;codecs="mp4a.40.2"` buffer, which the `^audio/` test ignores. A buffer with only video codecs in it is still skipped. Look at `changeType` too: hls.js switches the codec mid-stream (LC to HE-AAC), with a new init segment.
- **Hook, init segments:** `ftyp` is how every init segment seen starts, and `isInit` checks for it already. video.js sends the init and the first media in a single append. The demuxer handles that, as long as `init` only resets it.
- **Hook, `timestampOffset`:** players do set it: −10 s for video.js on a TS stream, and mid-stream changes on TED, down to −95,440 s. The media time of a sample is its `tfdt` time plus the offset. The hook has to send the offset with every append, read after the append when `mode` is `sequence`, since there the browser sets it itself (Shaka on HLS). With the offset read like that, every stream's samples line up with the browser's buffered ranges, within one AAC frame.
- **Analysis:** pick the decoder config from the track (`codec`, `description`) instead of `A_OPUS`. Set the resampler from the output's sample rate. Allow for small steps at segment boundaries: hls.js on Apple's stream overlaps by 22 ms, TED leaves 17 ms gaps, Twitch 3–8 ms. Today any step back over 1 ms resets the decoder, which would reset it at every segment there; about one AAC frame (24 ms) of slack would do. Ignore samples outside `appendWindowStart`/`End` (dash.js and Shaka set an end), as the browser drops them.
- **Priming:** Shaka's HLS stream has a 1024-sample edit list (21 ms), and the browsers differ on it by about that much. That is less than one Silero frame (32 ms), so it can be ignored.
- **Bytes kept:** YouTube's AAC is the same size as its Opus (1.1 MB per minute), so `KEEP_BYTES` holds.

## Still not covered

- Media Source in a worker: Twitch and Kick in Chrome. That is the IVS player, which uses the worker wherever the browser has it.
- Encrypted media, and AC-3/E-AC-3, which neither browser's WebCodecs decodes.
- Plain video files, which don't go through Media Source.
- Sites not probed here (Vimeo, Dailymotion, ČT). The libraries above are what most sites use, but a site's own player may differ.
