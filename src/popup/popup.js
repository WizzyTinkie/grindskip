// The toolbar popup: the settings, saved straight to storage (the content
// scripts follow storage), and the state of the active tab's video.
import { RECORD_START, RECORD_STOP, RESUME, STATUS } from '../shared/messages.js';
import { DEFAULTS, RANGES, load, migrate, save } from '../shared/settings.js';

const api = globalThis.browser ?? globalThis.chrome;
const POLL_MS = 400;
const STATES = { speech: 'Talking', wait: 'Pause', gameplay: 'Gameplay' };
const SENSITIVITY = { '-2': 'Lowest', '-1': 'Low', 0: 'Normal', 1: 'High', 2: 'Highest' };
const FORMAT = {
  talkSpeed: (v) => `${v.toFixed(2)}x`,
  playSpeed: (v) => `${v.toFixed(2)}x`,
  waitSec: (v) => `${+v.toFixed(2)} s`,
  sensitivity: (v) => SENSITIVITY[v],
};

const $ = (id) => document.getElementById(id);
let settings = DEFAULTS;
let recording = false;
let saved = null;        // the last recording's file name

function render() {
  $('enabled').checked = settings.enabled;
  for (const key of Object.keys(RANGES)) {
    $(key).value = settings[key];
    $(`${key}-out`).textContent = FORMAT[key](settings[key]);
  }
  $('fast-note').hidden = settings.playSpeed <= 3;
  $('rewind').checked = settings.rewind;
  $('overlay').checked = settings.overlay;
}

function change(patch) {
  settings = migrate({ ...settings, ...patch });
  render();
  save(api.storage, settings);
  poll();
}

for (const [key, r] of Object.entries(RANGES)) {
  Object.assign($(key), { min: r.min, max: r.max, step: r.step });
  $(key).addEventListener('input', (e) => change({ [key]: Number(e.target.value) }));
}
for (const key of ['enabled', 'rewind', 'overlay']) {
  $(key).addEventListener('change', (e) => change({ [key]: e.target.checked }));
}
$('reset').addEventListener('click', () => change({ ...DEFAULTS, enabled: settings.enabled }));
$('resume').addEventListener('click', async () => {
  await send({ type: RESUME });
  poll();
});

$('record').addEventListener('click', async () => {
  const r = await send({ type: recording ? RECORD_STOP : RECORD_START });
  saved = r?.file ? `Saved to your downloads as ${r.file}` : null;
  poll();
});

async function send(msg) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return await api.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;   // no content script here (a browser page, or not loaded yet)
  }
}

function showStatus(s) {
  let state = '–';
  let note = s?.note ?? saved;
  if (!s) note = 'Grindskip can’t run on this page.';
  else if (!s.enabled) state = 'Off';
  else if (!s.video) state = 'No video';
  else if (s.state) state = STATES[s.state];
  else state = note ? '–' : 'Waiting for the video to play';
  $('state').textContent = state;
  $('speed').textContent = s?.video && Number.isFinite(s.speed) ? `${s.speed.toFixed(2)}x` : '–';
  $('note').textContent = note ?? '';
  $('note').hidden = !note;
  $('resume').hidden = !s?.overridden;
  recording = !!s?.recording;
  $('record-box').hidden = !(s?.enabled && s.video) && !recording;
  $('record').textContent = recording ? `Stop and save (${clock(s.recording.seconds)}${s.recording.full ? ', full' : ''})` : 'Start a debug recording';
}

function clock(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

async function poll() {
  showStatus(await send({ type: STATUS }));
}

load(api.storage).then((s) => {
  settings = s;
  render();
  poll();
  setInterval(poll, POLL_MS);
});
