# Grindskip

A Chrome and Firefox extension for gameplay videos: it plays the video fast while no one is talking and at normal speed while someone is. Speech is detected locally with [Silero VAD](https://github.com/snakers4/silero-vad); no audio leaves the computer.

Work in progress; see [PLAN.md](PLAN.md).

## Building

Requires Node.js 24 (LTS) or newer.

```bash
npm install
```

```bash
npm run build
```

This writes the unpacked extension to `dist/chrome` and `dist/firefox`. `npm run watch` rebuilds whenever `src/`, `manifest/` or `assets/` change.

| Command | What it does |
|---|---|
| `npm test` | unit tests (Node's built-in test runner) |
| `npm run lint` | ESLint, then a build and `web-ext lint` on `dist/firefox` |
| `npm run start:firefox` | opens Firefox with `dist/firefox` installed, reloading it whenever the build changes (run `npm run watch` alongside) |

To load the build by hand:

- **Chrome:** `chrome://extensions`, turn on Developer mode, *Load unpacked*, pick `dist/chrome`. Click the reload icon on the extension's card after a rebuild.
- **Firefox:** `about:debugging#/runtime/this-firefox`, *Load Temporary Add-on*, pick `dist/firefox/manifest.json`. Firefox keeps the old code until you click *Reload* there.

## Using it

Click the Grindskip button in the toolbar and turn it on. On any page with a video, Grindskip then follows the largest one that plays with sound:

| Setting | Default | What it does |
|---|---|---|
| Speed while talking | 1x | the speed while someone is talking |
| Speed while playing | 2.5x | the speed while no one is; above 3x, loud gameplay is more often mistaken for speech |
| Wait before speeding up | 1.5 s | how long a pause has to be before the video speeds up |
| Sensitivity | Normal | higher: quieter or less clear speech also counts |
| Rewind on speech | off | after a stretch of gameplay, jumps back to where the talking started (at most 1.5 s) |
| Show the speech meter | off | draws the speech probability, the state and the speed over the video |

If you change the speed yourself, Grindskip leaves it alone on that video until you click *Change the speed again* in the popup, or the next video starts.

## Layout

- `src/`: the extension's code, bundled by esbuild: `content/` (video, capture, speed, overlay), `vad/` (Silero, resampler, offscreen client), `controller/` (the decisions), `popup/`, `shared/` (settings), and Chrome's `background/` and `offscreen/`
- `manifest/`: `base.json` plus the Chrome and Firefox additions, merged by the build
- `assets/`: the Silero model (and later the icons)
- `scripts/build.mjs`: the build
- `test/`: unit tests; `test/fixtures/traces.json` holds speech probabilities recorded in Phase 0, for replaying the controller
- `spikes/phase0/`: Phase 0 experiments and measurements, not shipped

## License

Apache 2.0, see [LICENSE](LICENSE). Third-party code and files are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
