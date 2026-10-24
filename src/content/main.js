// Content script: follows the page's main video and sets its playback speed,
// from an analysis of its audio before it plays where the player streams it
// through Media Source Extensions (lookahead/, fed by page/hook.js), or else
// by capturing its audio and running the speech detector on it live. It
// stays idle (no model, no capture) until Grindskip is on and an unmuted
// video plays.
import { FRAME_SEC, PARAMS, createController, startThreshold } from '../controller/controller.js';
import { createFeed } from '../lookahead/feed.js';
import { createLagMeter } from '../lookahead/lag.js';
import { LOOKAHEAD, createSchedule } from '../lookahead/schedule.js';
import { ADD_SAVED, RECORD_START, RECORD_STOP, RESUME, STATUS } from '../shared/messages.js';
import { DEFAULTS, load, watch } from '../shared/settings.js';
import { canCompileWasm, loadModel } from '../vad/load.js';
import { createRemoteVad } from '../vad/remote.js';
import { startCapture } from './capture.js';
import { createOverlay } from './overlay.js';
import { createRecorder } from './recorder.js';
import { countSaved } from './saved.js';
import { controlSpeed } from './speed.js';
import { isPlaying, trackVideo } from './video.js';

const api = globalThis.browser ?? globalThis.chrome;
// Frames waiting for the detector; older ones are dropped beyond this (0.5 s)
const MAX_QUEUE = 16;
// Failed frames in a row before the status says so (1 s)
const MAX_FAILURES = 31;
// How often the time saved is added to the total
const REPORT_SAVED_MS = 10000;
// How often the speed follows the look-ahead schedule
const TICK_MS = 30;
// Look-ahead keeps this much of the analysis behind the playing position,
// for seeking back
const KEEP_BEHIND_SEC = 120;
// On top of the measured time a speed change takes, for the tick and noise
const LAG_MARGIN_SEC = 0.06;

let settings = DEFAULTS;
let stopTracking = null;
let follow = null;      // the pipeline for the followed video
let vad = null;         // promise of the page's speech detector
let feed = null;        // the look-ahead feed from the page hook, while on
// How long a speed change takes to take effect here (the browser and the
// output device), for look-ahead's lead; kept across videos, and in storage
// across pages, so the first speech on the next page is caught too
const LAG_KEY = 'lookaheadLag';
const lag = createLagMeter(() => {
  api.storage.local.set({ [LAG_KEY]: lag.estimate }).catch(() => {});
});
api.storage.local.get(LAG_KEY).then((d) => lag.seed(d[LAG_KEY]), () => {});
let overlay = null;
let recorder = null;    // the debug recording, while one runs

// The speech detector, loaded on first use: in the content script, or in
// Chrome's offscreen document when the page's CSP stops this script
// compiling WebAssembly. Resolves to { where, createStream(), release() };
// each stream ({ process, reset, release? }) has its own model state.
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
      return { where: 'content script', createStream: model.createStream, release: model.release };
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
  // One port per stream, starting with the one just tried
  let spare = remote;
  const streams = new Set();
  return {
    where: 'offscreen document',
    createStream() {
      const s = spare ?? createRemoteVad(api.runtime);
      spare = null;
      streams.add(s);
      return s;
    },
    release() {
      for (const s of [...streams, spare]) s?.release();
    },
  };
}

// A stream of the speech detector that loads it on first use
function lazyStream() {
  let stream = null;
  const get = () => (stream ??= getVad().then((v) => v.createStream()));
  return {
    process: (frame) => get().then((s) => s.process(frame)),
    reset: () => stream?.then((s) => s.reset(), () => {}),
    release: () => stream?.then((s) => s.release?.(), () => {}),
  };
}

function releaseVad() {
  const v = vad;
  vad = null;
  v?.then((x) => x.release()).catch(() => {});
}

// Everything for one video: the speed, decided by look-ahead while the
// video's audio can be analysed before it plays (lookahead/), or else by
// listening live: capture and controller.
function createPipeline(video) {
  const controller = createController(settings);
  const speed = controlSpeed(video, (rate) => {
    recorder?.event('override', { rate });
    show();
  });
  const saved = countSaved(video, () => !speed.overridden);
  let detector = null;     // its live stream
  let where = null;
  let capture = null;
  let starting = false;
  let stopped = false;
  let error = null;
  let generation = 0;     // bumped on seeks and new sources; older frames are dropped
  let queue = [];
  let pumping = false;
  let failures = 0;       // frames in a row the detector failed on
  let last = null;        // the latest frame's probability and decision
  let schedule = null;    // look-ahead's, while it decides
  let analysis = null;    // the look-ahead analysis it follows

  async function begin() {
    if (schedule || starting || capture || error || video.muted || video.paused) return;
    starting = true;
    show();
    try {
      const v = await getVad();
      where = v.where;
      detector ??= v.createStream();
      // Look-ahead may have taken over while the model loaded
      if (stopped || schedule) return;
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
      if (item.generation !== generation || stopped || schedule) continue;
      const r = Number.isFinite(p) ? decide(p, item.meta) : null;
      recorder?.frame(item.frame, { p, inferMs, ...item.meta, state: r?.state, speed: r?.speed });
    }
    pumping = false;
  }

  function decide(p, meta) {
    const r = controller.frame({ p, rate: meta.rate });
    last = { p, ...r };
    speed.set(r.speed);
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

  // Look-ahead: while the video's audio is analysed before it plays, the
  // speed follows the schedule, and the live capture is off
  function tick() {
    const a = feed?.analysis;
    const usable = a && a.supported && !a.error ? a : null;
    if (usable && usable !== analysis) {
      capture?.stop();
      capture = null;
      restart('look-ahead');
      analysis = usable;
      schedule = createSchedule(usable.timeline, settings);
      schedule.reset(video.currentTime);
      getVad().then((v) => { where = v.where; }, () => {});
      recorder?.event('mode', { mode: 'look-ahead' });
    } else if (!usable && schedule) {
      schedule = null;
      analysis = null;
      controller.reset();
      recorder?.event('mode', { mode: 'live' });
      begin();
    }
    // Muted videos are left alone, as when listening live
    if (!schedule || !isPlaying(video) || video.muted) return;
    const t = video.currentTime;
    const now = performance.now() / 1000;
    lag.sample(now, t);
    if (analysis.timeline.size > 2 * KEEP_BEHIND_SEC / FRAME_SEC) analysis.timeline.prune(t - KEEP_BEHIND_SEC);
    const at = schedule.at(t, leadSec());
    const p = analysis.timeline.at(t) ?? null;
    const start = startThreshold(1, settings.sensitivity);
    const state = at === 'gameplay' ? 'gameplay' : p !== null && p >= start ? 'speech' : 'wait';
    // Talk speed until the analysis reaches far enough ahead to know
    const rate = at === 'gameplay' ? settings.playSpeed : settings.talkSpeed;
    last = { p, start, end: PARAMS.end, state, speed: rate, known: at !== null };
    const before = video.playbackRate;
    speed.set(rate);
    if (video.playbackRate !== before) lag.changed(now, t, before, video.playbackRate);
    show();
  }
  const ticker = setInterval(tick, TICK_MS);

  const onSeeking = () => {
    schedule?.reset(video.currentTime);
    lag.reset();
    controller.reset();
    restart('seek');
  };
  const onLoadStart = () => {
    feed?.follow(video.currentSrc);
    schedule = null;
    analysis = null;
    controller.reset();
    speed.resume();
    reportSaved(saved);
    saved.newVideo();
    last = null;
    restart('new source');
    show();
  };
  const events = { playing: begin, volumechange: begin, seeking: onSeeking, loadstart: onLoadStart };
  for (const [name, fn] of Object.entries(events)) video.addEventListener(name, fn);
  begin();

  // How far the look-ahead analysis reaches beyond the playing position,
  // and how long speed changes take to take effect
  function lookaheadStatus() {
    if (!feed) return null;
    const a = feed.analysis;
    const ms = (x) => (x === null ? null : Math.round(x * 1000));
    return { ...feed.status(), ahead: a ? +a.timeline.ahead(video.currentTime).toFixed(2) : 0, lagMs: ms(lag.estimate), lastLagMs: ms(lag.last), leadMs: ms(leadSec()) };
  }

  function note() {
    if (schedule) {
      if (speed.overridden) return 'Speed changed by hand, so Grindskip has stopped changing it on this video';
      return last && !last.known ? 'Analysing the audio ahead…' : null;
    }
    if (error) return error;
    if (starting) return 'Loading the speech detector…';
    if (failures >= MAX_FAILURES) return 'The speech detector isn’t responding';
    if (speed.overridden) return 'Speed changed by hand, so Grindskip has stopped changing it on this video';
    if (capture?.suspended) return 'Click the page to start listening';
    return null;
  }

  return {
    video,
    saved,
    configure(s) {
      controller.configure(s);
      schedule?.configure(s);
    },
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
        where,
        mode: schedule ? 'look-ahead' : 'live',
        lookahead: lookaheadStatus(),
        note: note(),
        saved: { video: saved.seconds, unsent: saved.unsent },
      };
    },
    stop() {
      stopped = true;
      clearInterval(ticker);
      generation++;
      queue = [];
      for (const [name, fn] of Object.entries(events)) video.removeEventListener(name, fn);
      capture?.stop();
      speed.restore();
      speed.stop();
      reportSaved(saved);
      saved.stop();
    },
  };
}

// Adds the time saved since the last report to the total, through the
// background script
function reportSaved(saved) {
  const seconds = saved?.take() ?? 0;
  if (seconds === 0) return;
  try {
    api.runtime.sendMessage({ type: ADD_SAVED, seconds }).catch(() => {});
  } catch {
    // The extension was reloaded or removed; this script is left over
  }
}

// How long before speech look-ahead slows down, in wall time: enough for
// the speed change to take effect
function leadSec() {
  return Math.max(LOOKAHEAD.leadSec, (lag.estimate ?? 0) + LAG_MARGIN_SEC);
}

function followVideo(video) {
  follow?.stop();
  if (video && settings.lookahead) feed ??= createFeed(lazyStream);
  feed?.follow(video?.currentSrc ?? null);
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
  // Without the feed, the pipeline goes back to listening live on its next tick
  if (!settings.lookahead && feed) {
    feed.close();
    feed = null;
  } else if (settings.lookahead && !feed && follow) {
    feed = createFeed(lazyStream);
    feed.follow(follow.video.currentSrc);
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
const reportFollowed = () => reportSaved(follow?.saved);
setInterval(reportFollowed, REPORT_SAVED_MS);
// The page may be closing: report now rather than lose up to 10 s
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') reportFollowed();
});
window.addEventListener('pagehide', reportFollowed);

// For the evaluation build (eval/ext), which drives this script from tests
export const control = { ready, apply, status, startRecording, stopRecording, saveRecording };
