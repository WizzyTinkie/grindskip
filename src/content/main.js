// Content script: follows the page's main video, captures its audio, runs
// the speech detector on it and sets the playback speed. It stays idle (no
// model, no capture) until Grindskip is on and an unmuted video plays.
import { createController } from '../controller/controller.js';
import { RESUME, STATUS } from '../shared/messages.js';
import { DEFAULTS, load, watch } from '../shared/settings.js';
import { canCompileWasm, loadModel } from '../vad/load.js';
import { createRemoteVad } from '../vad/remote.js';
import { startCapture } from './capture.js';
import { createOverlay } from './overlay.js';
import { controlSpeed } from './speed.js';
import { trackVideo } from './video.js';

const api = globalThis.browser ?? globalThis.chrome;
// Frames waiting for the detector; older ones are dropped beyond this (0.5 s)
const MAX_QUEUE = 16;
// Failed frames in a row before the status says so (1 s)
const MAX_FAILURES = 31;

let settings = DEFAULTS;
let stopTracking = null;
let follow = null;      // the pipeline for the followed video
let vad = null;         // promise of the page's speech detector
let overlay = null;

// The speech detector, loaded on first use: in the content script, or in
// Chrome's offscreen document when the page's CSP stops this script
// compiling WebAssembly.
function getVad() {
  vad ??= openVad().catch((e) => {
    vad = null;
    throw e;
  });
  return vad;
}

async function openVad() {
  let localError = null;
  if (canCompileWasm()) {
    try {
      const model = await loadModel(api.runtime);
      const stream = model.createStream();
      return { process: stream.process, reset: stream.reset, release: model.release };
    } catch (e) {
      localError = e;
    }
  }
  // Only Chrome has the offscreen document; elsewhere this fails too
  const remote = createRemoteVad(api.runtime);
  try {
    await remote.ready();
  } catch (e) {
    throw localError ?? e;
  }
  return remote;
}

function releaseVad() {
  const v = vad;
  vad = null;
  v?.then((x) => x.release()).catch(() => {});
}

// Everything for one video: capture, controller and speed.
function createPipeline(video) {
  const controller = createController(settings);
  const speed = controlSpeed(video, () => show());
  let detector = null;
  let capture = null;
  let starting = false;
  let stopped = false;
  let error = null;
  let generation = 0;     // bumped on seeks and new sources; older frames are dropped
  let queue = [];
  let pumping = false;
  let selfSeek = false;
  let failures = 0;       // frames in a row the detector failed on
  let last = null;        // the latest frame's probability and decision

  async function begin() {
    if (starting || capture || error || video.muted || video.paused) return;
    starting = true;
    show();
    try {
      detector = await getVad();
      if (stopped) return;
      capture = startCapture(video, onFrame);
    } catch (e) {
      console.warn('Grindskip:', e);
      error = detector ? 'Can’t listen to this video' : 'The speech detector didn’t load';
    } finally {
      starting = false;
    }
    show();
  }

  function onFrame(frame, meta) {
    queue.push({ frame, meta, generation });
    if (queue.length > MAX_QUEUE) queue.shift();
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length && !stopped) {
      const item = queue.shift();
      let p;
      try {
        p = await detector.process(item.frame);
        failures = 0;
      } catch (e) {
        // The offscreen port dropped; the next frame reconnects
        if (failures++ === 0) console.warn('Grindskip:', e);
        if (failures === MAX_FAILURES) show();
        p = NaN;
      }
      if (item.generation !== generation || stopped || !Number.isFinite(p)) continue;
      decide(p, item.meta);
    }
    pumping = false;
  }

  function decide(p, meta) {
    const r = controller.frame({ p, rate: meta.rate, mediaTime: meta.mediaTime });
    last = { p, ...r };
    speed.set(r.speed);
    if (r.rewindTo !== null && !speed.overridden) {
      selfSeek = true;
      video.currentTime = r.rewindTo;
    }
    show();
  }

  // Drops what was heard so far: after a seek, or a new source
  function restart() {
    generation++;
    queue = [];
    capture?.reset();
    detector?.reset();
  }

  const onSeeking = () => {
    if (selfSeek) selfSeek = false;
    else controller.reset({ seek: true });
    restart();
  };
  const onLoadStart = () => {
    controller.reset();
    speed.resume();
    last = null;
    restart();
    show();
  };
  const events = { playing: begin, volumechange: begin, seeking: onSeeking, loadstart: onLoadStart };
  for (const [name, fn] of Object.entries(events)) video.addEventListener(name, fn);
  begin();

  function note() {
    if (error) return error;
    if (starting) return 'Loading the speech detector…';
    if (failures >= MAX_FAILURES) return 'The speech detector isn’t responding';
    if (speed.overridden) return 'Speed changed by hand, so Grindskip has stopped changing it on this video';
    if (capture?.suspended) return 'Click the page to start listening';
    return null;
  }

  return {
    video,
    configure(s) { controller.configure(s); },
    resume() {
      speed.resume();
      if (last) speed.set(last.speed);
      show();
    },
    status() {
      return {
        state: last?.state ?? null,
        speed: video.playbackRate,
        p: last?.p ?? null,
        start: last?.start ?? null,
        end: last?.end ?? null,
        overridden: speed.overridden,
        note: note(),
      };
    },
    stop() {
      stopped = true;
      generation++;
      queue = [];
      for (const [name, fn] of Object.entries(events)) video.removeEventListener(name, fn);
      capture?.stop();
      speed.restore();
      speed.stop();
    },
  };
}

function followVideo(video) {
  follow?.stop();
  follow = video ? createPipeline(video) : null;
  show();
}

function show() {
  if (!(settings.enabled && settings.overlay && follow)) {
    overlay?.remove();
    overlay = null;
    return;
  }
  overlay ??= createOverlay();
  overlay.update({ video: follow.video, ...follow.status() });
}

function apply(next) {
  settings = next;
  if (settings.enabled && !stopTracking) {
    stopTracking = trackVideo(document, followVideo);
  } else if (!settings.enabled && stopTracking) {
    stopTracking();
    stopTracking = null;
    followVideo(null);
    releaseVad();
  }
  follow?.configure(settings);
  show();
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === STATUS) {
    sendResponse({ enabled: settings.enabled, video: !!follow, ...follow?.status() });
  } else if (msg?.type === RESUME) {
    follow?.resume();
    sendResponse({ ok: true });
  }
});

load(api.storage).then(apply);
watch(api.storage, apply);
