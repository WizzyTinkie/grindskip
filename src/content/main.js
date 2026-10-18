// Content script: follows the page's main video, captures its audio, runs
// the speech detector on it and sets the playback speed. It stays idle (no
// model, no capture) until Grindskip is on and an unmuted video plays.
import { PARAMS, createController } from '../controller/controller.js';
import { RECORD_START, RECORD_STOP, RESUME, STATUS } from '../shared/messages.js';
import { DEFAULTS, load, watch } from '../shared/settings.js';
import { canCompileWasm, loadModel } from '../vad/load.js';
import { createRemoteVad } from '../vad/remote.js';
import { startCapture } from './capture.js';
import { createOverlay } from './overlay.js';
import { createRecorder } from './recorder.js';
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
let recorder = null;    // the debug recording, while one runs

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
      return { where: 'content script', process: stream.process, reset: stream.reset, release: model.release };
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
  return Object.assign(remote, { where: 'offscreen document' });
}

function releaseVad() {
  const v = vad;
  vad = null;
  v?.then((x) => x.release()).catch(() => {});
}

// Everything for one video: capture, controller and speed.
function createPipeline(video) {
  const controller = createController(settings);
  const speed = controlSpeed(video, (rate) => {
    recorder?.event('override', { rate });
    show();
  });
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
    if (queue.length > MAX_QUEUE) {
      queue.shift();
      recorder?.event('drop');
    }
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length && !stopped) {
      const item = queue.shift();
      let p;
      const t0 = performance.now();
      try {
        p = await detector.process(item.frame);
        failures = 0;
      } catch (e) {
        // The offscreen port dropped; the next frame reconnects
        if (failures++ === 0) console.warn('Grindskip:', e);
        if (failures === MAX_FAILURES) show();
        p = NaN;
      }
      const inferMs = performance.now() - t0;
      if (item.generation !== generation || stopped) continue;
      const r = Number.isFinite(p) ? decide(p, item.meta) : null;
      recorder?.frame(item.frame, { p, inferMs, ...item.meta, state: r?.state, speed: r?.speed });
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
    return r;
  }

  // Drops what was heard so far: after a seek, or a new source
  function restart(reason) {
    recorder?.event('reset', { reason });
    generation++;
    queue = [];
    capture?.reset();
    detector?.reset();
  }

  const onSeeking = () => {
    const rewind = selfSeek;
    selfSeek = false;
    if (!rewind) controller.reset({ seek: true });
    restart(rewind ? 'rewind' : 'seek');
  };
  const onLoadStart = () => {
    controller.reset();
    speed.resume();
    last = null;
    restart('new source');
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
        where: detector?.where ?? null,
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
  recorder?.event('settings', { settings });
  show();
}

function status() {
  const rec = recorder && { seconds: recorder.seconds, full: recorder.full };
  return { enabled: settings.enabled, video: !!follow, recording: rec, ...follow?.status() };
}

function startRecording() {
  recorder = createRecorder({
    url: location.href,
    userAgent: navigator.userAgent,
    settings,
    params: PARAMS,
  });
}

// Ends the recording and returns it (a plain object, see recorder.js).
function stopRecording() {
  const rec = recorder?.toJSON() ?? null;
  recorder = null;
  return rec;
}

// Ends the recording and saves it to a file; returns the file name.
function saveRecording() {
  const rec = stopRecording();
  return rec && download(rec);
}

// Saves a recording through a link in the page: the popup can't, since it
// closes when the save dialog opens.
function download(rec) {
  const name = `grindskip-${rec.created.replace(/[:.]/g, '-')}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(rec)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return name;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === STATUS) {
    sendResponse(status());
  } else if (msg?.type === RESUME) {
    follow?.resume();
    sendResponse({ ok: true });
  } else if (msg?.type === RECORD_START) {
    startRecording();
    sendResponse({ ok: true });
  } else if (msg?.type === RECORD_STOP) {
    sendResponse({ ok: true, file: saveRecording() });
  }
});

const ready = load(api.storage).then(apply);
watch(api.storage, apply);

// For the evaluation build (eval/ext), which drives this script from tests
export const control = { ready, apply, status, startRecording, stopRecording, saveRecording };
