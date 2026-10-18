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

## Layout

- `src/`: the extension's code, bundled by esbuild
- `manifest/`: `base.json` plus the Chrome and Firefox additions, merged by the build
- `assets/`: the Silero model (and later the icons)
- `scripts/build.mjs`: the build
- `test/`: unit tests
- `spikes/phase0/`: Phase 0 experiments and measurements, not shipped

## License

Apache 2.0, see [LICENSE](LICENSE). Third-party code and files are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
