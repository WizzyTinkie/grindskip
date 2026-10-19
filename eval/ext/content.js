// Content script of the evaluation build (node scripts/build.mjs --eval):
// the product's content script, plus a way for a test driver in the page to
// control it, since drivers can't always open extension pages (Firefox's
// WebDriver BiDi can't). Never shipped.
//
// The driver dispatches `grindskip-eval` on document with a JSON string
// { id, cmd, args }; the reply comes back as `grindskip-eval-reply` with a
// JSON string { id, ok, result | error }.
import { control } from '../../src/content/main.js';
import { DEFAULTS } from '../../src/shared/settings.js';
import { load as loadStats } from '../../src/shared/stats.js';

const api = globalThis.browser ?? globalThis.chrome;

const handlers = {
  // Settings as given, without migrate(): tests may set both speeds to the
  // same value to hold the video at a fixed speed
  settings: (s) => control.apply({ ...DEFAULTS, ...s }),
  status: () => control.status(),
  // The stored total of time saved (shared/stats.js)
  stats: () => loadStats(api.storage),
  recordStart: () => control.startRecording(),
  recordStop: () => control.stopRecording(),
  recordSave: () => control.saveRecording(),
};

document.addEventListener('grindskip-eval', async (e) => {
  let msg;
  try {
    msg = JSON.parse(e.detail);
  } catch {
    return;
  }
  let reply;
  try {
    await control.ready;
    reply = { id: msg.id, ok: true, result: (await handlers[msg.cmd](msg.args ?? {})) ?? null };
  } catch (err) {
    reply = { id: msg.id, ok: false, error: String(err?.stack ?? err) };
  }
  document.dispatchEvent(new CustomEvent('grindskip-eval-reply', { detail: JSON.stringify(reply) }));
});

control.ready.then(() => {
  document.documentElement.dataset.grindskipEval = 'ready';
});
