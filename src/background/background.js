// The background script (Chrome's service worker, Firefox's event page):
// turns Grindskip on or off from the keyboard shortcut, shows whether it's
// on with a green or gray toolbar icon, adds the time saved that the tabs
// report to the stored total and, in Chrome, opens the offscreen document when a content script can't compile
// WebAssembly under the page's CSP, and closes it when the document says
// it's idle.
import { ADD_SAVED } from '../shared/messages.js';
import { load, toggle, watch } from '../shared/settings.js';
import { createSaver } from '../shared/stats.js';
import { CLOSE_OFFSCREEN, ENSURE_OFFSCREEN } from '../vad/remote.js';

const api = globalThis.browser ?? globalThis.chrome;
const addSaved = createSaver(api.storage);
let creating = null;

// The command's name in manifest/base.json
const TOGGLE = 'toggle';
// The manifest's default icon is the gray one, as Grindskip starts off
function showEnabled(enabled) {
  const name = enabled ? 'icon' : 'icon-off';
  api.action.setIcon({ path: { 16: `${name}-16.png`, 32: `${name}-32.png` } }).catch(() => {});
}

api.commands.onCommand.addListener((command) => {
  if (command === TOGGLE) toggle(api.storage).catch((e) => console.warn('Grindskip:', e));
});
// The popup and the shortcut both change the setting in storage
watch(api.storage, (s) => showEnabled(s.enabled));
load(api.storage).then((s) => showEnabled(s.enabled), () => {});

async function ensureOffscreen() {
  if (await api.offscreen.hasDocument()) return;
  creating ??= api.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Runs the speech detector for videos on pages that block WebAssembly in content scripts',
  }).finally(() => {
    creating = null;
  });
  await creating;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === ADD_SAVED) {
    if (Number.isFinite(msg.seconds)) addSaved(msg.seconds);
    return false;
  }
  // Only Chrome has the offscreen document
  if (!api.offscreen) return false;
  if (msg?.type === ENSURE_OFFSCREEN) {
    ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
    );
    return true;
  }
  if (msg?.type === CLOSE_OFFSCREEN) {
    api.offscreen.closeDocument().catch(() => {});
  }
  return false;
});
