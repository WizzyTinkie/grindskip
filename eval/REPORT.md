# Phase 3 report

Date: 2026-10-18. How to rerun everything is in [README.md](README.md).

## Summary

The controller meets the targets at the default gameplay speed (2.5x) on the speech the model can hear, in both browsers, except rewind's 99%. Tuning raised the start threshold at gameplay speed from 0.8 to 0.9 and lowered the minimum speech from 3 frames to 2, which removes most false slowdowns at 4x and costs nothing at 2–3x. Rewind now goes 0.5 s further back than the detected onset instead of 0.25 s.

Measured against all of the auto-captions, commentary heard at talk speed is about 92–93%. The difference is caption words the model doesn't respond to at all, even at 1x: some captions are mistimed, and others mark quiet or unclear sounds in long gameplay stretches. No threshold can catch these. Whether they are real speech needs someone to listen (see [Open items](#open-items)).

| Measure | Target | Chrome, 2.5x | Firefox, 2.5x |
|---|---|---|---|
| Commentary heard at talk speed (speech the model hears) | ≥ 95% | 96.8% | 95.7% |
| … with rewind on | ≥ 99% | 98.7% | 97.4% |
| … against all captions | | 92.8% | 91.9% |
| Non-commentary played at gameplay speed | ≥ 90% | 97.9% | 97.7% |
| False slowdowns | | 0 in 3.4 min | 0 in 3.4 min |
| Median delay before talk speed (speech the model hears) | ≤ 0.4 s | 0.10 s | 0.26 s |
| Inference per frame, in the content script | | 0.44 ms (1.4% of a core) | 0.49 ms (1.5%) |

## Test set

Five sections of Let's Play videos of Risen, 13 minutes in all (`lib/clips.mjs`):

| Clip | Video | Section | Content | Speech in the captions |
|---|---|---|---|---|
| risen | [Morgannin, RISEN Part 1](https://www.youtube.com/watch?v=BFG1Q7zpNtE) | 0–120 s | music intro until 16 s, then continuous commentary | 79% |
| bumpy | [Bumpy McSquigums, Let's Play Risen ep. 1](https://www.youtube.com/watch?v=4ThQDMlPWM0) | 0–120 s | dense commentary with a quieter stretch | 65% |
| mattg | [AwesomeMattG, Let's Play Risen 001](https://www.youtube.com/watch?v=ZCC-wZjgHFo&t=90) | 90–210 s | commentary, then a minute of gameplay with little talking | 28% |
| nocomm | [Ishikawa Kun, Risen [No Commentary]](https://www.youtube.com/watch?v=ZJ0hHIcMATk) | 0–120 s | music, narrated intro (in-game voice), game sound | 25% |
| sparse | [Morgannin, Let's Play Risen Part 1](https://www.youtube.com/watch?v=v4w8WzKm0Mg&t=390) | 390–690 s | five minutes of gameplay with a few remarks | 2% |

The first three and nocomm are Phase 0's clips (risen is new); sparse was picked from the captions as the five minutes with the least talking that still has a few remarks.

**Labels.** The speech labels are the auto-captions' word timings, used as they are (no correction by hand). A word ends where the next starts, at most 0.6 s later; words less than 0.3 s apart are merged; tags such as `[Music]` don't count.

How well they agree with Silero at 1x (`node run.mjs --labels`), Chrome; Firefox is within a point:

| Clip | Model > 0.5 in labelled speech | Model ≤ 0.5 elsewhere | Best caption shift |
|---|---|---|---|
| risen | 88.6% | 85.2% | −0.10 s |
| bumpy | 84.6% | 82.7% | −0.20 s |
| mattg | 66.8% | 97.6% | 0 |
| nocomm | 74.0% | 94.5% | +0.50 s |
| sparse | 30.3% | 99.3% | 0 |

On the dense clips the two agree as far as word-level captions can (the captions bridge short pauses, and the model hears speech in some places the captions leave out). In mattg and sparse, most of the caption onsets in the gameplay stretches never reach 0.1 at 1x: at 91.6, 95.2 and 98.2 s in mattg ("where am", "I", "okay") and at 6.6 and 104.1 s in sparse ("yeah", "they didn't like"), the model stays at or below 0.07 within ±3 s. At 2.6 and 22.5 s in mattg the model does hear speech within ±3 s of the caption, so those captions are mistimed. To keep this noise out of the comparison, `--audible` scores only the labelled speech that the model scores above 0.5 somewhere at 1x in both browsers; both kinds of score are below.

## Method

**Recording.** `record.mjs` plays each clip at 1x, 2x, 2.5x, 3x and 4x in Chrome for Testing 155 and Firefox 157, through the extension itself: the evaluation build is the product plus a hook to set its settings and run its debug recording from the page. With both of Grindskip's speeds set to the clip's speed, it analyses as usual but never changes the speed. Each recording keeps the 16 kHz audio the extension analysed, the browser's speech probability for every frame, the media times and the inference times. All 50 recordings ran in the content script, into a null sink, with no frames dropped.

**Replay.** `run.mjs` replays each clip through the controller closed-loop. The controller hears the recording at the speed it has chosen, at the current media position, and a speed change reaches the audio two frames late (Phase 0 measured 10–75 ms). Talk speed is 1x throughout. The browsers' own probabilities are used; `--probs node` reruns Silero on the recorded audio instead, which Phase 0 showed gives the same values to within 0.016.

**Measures** (see `lib/simulate.js`):

- commentary heard at talk speed: share of the labelled speech played at 1x (with rewind, heard at 1x at least once);
- non-commentary at gameplay speed: share of the media without labelled speech played at gameplay speed, leaving out the wait after each stretch of speech, which is meant to be slow;
- false slowdowns: switches to talk speed with no labelled speech from 1.5 s before to 1 s after, counted in the wall-clock minutes of media without speech;
- delay: wall time from a labelled onset (after at least 1 s without speech) reached at gameplay speed to the switch; onsets with no switch within 3 s count as missed.

## Results

### Before and after tuning

Previous defaults: start threshold 0.8 at gameplay speed, 3 frames. New: 0.9 and 2 frames. Every gameplay speed, all captions, both browsers added up:

| Gameplay speed | Speech at talk speed (Chrome / Firefox), before → after | False slowdowns, before → after | Median delay, before → after |
|---|---|---|---|
| 2x | 93.4 / 92.7% → 93.6 / 92.8% | 3 → 3 in 8.0 min | 0.54–0.58 s → 0.58 s |
| 2.5x | 92.8 / 91.7% → 92.8 / 91.9% | 0 → 0 in 6.5 min | 0.42–0.45 s → 0.42 s |
| 3x | 91.7 / 91.5% → 91.9 / 91.6% | 1 → 0 in 5.5 min | 0.42–0.48 s → 0.38–0.45 s |
| 4x | 91.7 / 88.4% → 91.8 / 88.6% | 8 → 3 in 4.3 min | 0.29–0.35 s → 0.29–0.32 s |

On the speech the model hears (`--audible`):

| Gameplay speed | Speech at talk speed (Chrome / Firefox), before → after | False slowdowns, before → after | Median delay (Chrome / Firefox), after |
|---|---|---|---|
| 2x | 97.4 / 96.6% → 97.6 / 96.8% | 3 → 3 | 0.26 / 0.19 s |
| 2.5x | 96.8 / 95.6% → 96.8 / 95.7% | 0 → 0 | 0.10 / 0.26 s |
| 3x | 95.6 / 95.3% → 95.8 / 95.5% | 1 → 0 | 0.16 / 0.22 s |
| 4x | 95.4 / 92.3% → 95.8 / 92.6% | 9 → 3 | 0.10 / 0.13 s |

Non-commentary played at gameplay speed is 96–98% at every speed, before and after.

### Per clip, at 2.5x, all captions

| Clip | Chrome: speech / quiet / false / delay / missed | Firefox: speech / quiet / false / delay / missed |
|---|---|---|
| risen | 99.6% / 90.0% / 0 / 0.06 s / 0 | 99.4% / 90.1% / 0 / 0.13 s / 0 |
| bumpy | 97.3% / 94.6% / 0 / 0.22 s / 0 | 97.4% / 94.4% / 0 / 0.29 s / 0 |
| mattg | 76.2% / 98.7% / 0 / 0.96 s / 4 | 76.7% / 98.8% / 0 / 0.70 s / 4 |
| nocomm | 92.2% / 97.4% / 0 / 0.42 s / 0 | 87.8% / 96.7% / 0 / 0.42 s / 0 |
| sparse | 22.7% / 98.5% / 0 / 0.61 s / 3 | 6.5% / 98.5% / 0 / 1.41 s / 3 |

The sparse clip has only 6 s of captioned speech, and the model hears one remark ("this cave seems a little eerie, please") clearly. Its percentages move a lot with a single word.

### The sweep

`node run.mjs --sweep` tried 200 combinations at each gameplay speed: start threshold at talk speed 0.4/0.5/0.6, at gameplay speed 0.6–0.9, end threshold 0.25/0.35/0.45, and a minimum speech of 1–6 frames. It kept the combinations that no other one beats on all three of false slowdowns, speech kept and delay.

- A start threshold of 0.9 at gameplay speed is on the front at every speed. Below 0.85, false slowdowns climb quickly at 3x and 4x (up to 7–14 at 0.6).
- With 0.9, one frame is best at 2.5x and 3x (0.5–1 point more speech, one frame less delay, no false slowdowns), but 4x then gets 9 false slowdowns. Two frames is the setting that is never worse than the old defaults at any speed, so that's the new default.
- The talk-speed start threshold and the end threshold hardly matter here: 0.4 instead of 0.5 adds about 0.1 point of speech, and 0.25 against 0.35 changes nothing measurable. Both stay at Silero's usual values (0.5 and 0.35).
- At 4x, nothing gets rid of false slowdowns without losing speech: the only combination with none (0.9, 6 frames) keeps just 85–89% of the speech, and the others keep 1–3 in 4.3 minutes or more. The popup's note that loud gameplay may slow the video down above 3x stays.

The test set is small (13 minutes, 6.5 minutes of media without speech per browser at 2.5x, a handful of false slowdowns at most), so differences of a point or one event are within the noise. The change is kept small for that reason.

### Rewind

Rewind went back 0.25 s before the first frame above the threshold. The replay showed it landing 0.4–1.2 s after the caption onsets, because the probability takes a few frames to cross 0.9. On the speech the model hears, at 2.5x:

| Margin before the detected onset | Chrome | Firefox |
|---|---|---|
| 0.25 s (before) | 98.3% | 97.0% |
| 0.5 s (new) | 98.7% | 97.4% |
| 0.75 s | 98.9% | 97.7% |
| 1.0 s | 99.1% | 97.8% |

0.5 s is the new margin. More gets closer to 99% but replays more game sound every time, and the onsets it still misses are mostly ones where the captions start well before the model hears anything.

The other safeguard matters more. Rewind only happens after 3 s at gameplay speed, so speech that resumes just after the video sped up (a pause a little longer than the wait) isn't rewound. At 2.5x with the 0.5 s margin:

| Gameplay needed before a rewind | Chrome | Firefox | Rewinds |
|---|---|---|---|
| 3 s (as planned) | 98.7% | 97.4% | 7 in 8.1 min |
| 1.5 s or 0.5 s | 98.7% | 97.4% | 7–8 |
| none | 99.4% | 98.6% | 11 |

Dropping the minimum meets the 99% target in Chrome; the 4 extra rewinds are all speech resuming within half a second of the speed-up. PLAN.md asks for a few seconds, so the 3 s stays for now (see [Open items](#open-items)).

### Cost

Inference in the content script, from the 120,000 recorded frames: 0.44 ms per frame in Chrome (p99 0.70 ms) and 0.49 ms in Firefox (p99 2 ms, at Firefox's 1 ms timer resolution), about 1.5% of one core. With capture and resampling, Phase 0 measured about 2% in all. The target is 5%.

### End to end

With the new defaults, the product build on the local player page (mattg clip, Chrome, rewind on) switched speed six times in a minute, matching the commentary, and rewound twice by 0.58 s at speech onsets.

## Debug recording

The popup now has *Start a debug recording*: until stopped (at most 10 minutes), the content script keeps the 16 kHz audio it analysed, its probabilities, decisions, media times and inference times, and the resets, seeks and speed overrides between them. *Stop and save* downloads it as `grindskip-<time>.json`, through a link in the page (the popup would close when the save dialog opens). It downloaded in both browsers. The recordings `record.mjs` makes have the same format.

## Open items

- **Rewind after short gameplay:** whether to rewind even when the video sped up only a moment ago (see [Rewind](#rewind)). That would bring the share heard at talk speed with rewind to 99.4% in Chrome and 98.6% in Firefox, at about one more rewind every two minutes.
- **Final check on real hardware:** Grindskip in Chrome and Firefox on real videos with real output devices (Bluetooth, Windows, macOS), including the speed-change lag, which Phase 0 only measured on a PipeWire null sink. This needs a person.
- **Labels:** about seven caption onsets in mattg and sparse (listed under [Test set](#test-set)) are never heard by the model. A person listening to those spots would tell whether they are speech the model misses (a case for Phase 5's fine-tuning) or caption noise.
- **A bigger test set:** more gameplay without talking, especially for 4x, where the false slowdowns are.
