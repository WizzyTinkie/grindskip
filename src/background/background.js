// The background script (Chrome's service worker, Firefox's event page):
// adds the time saved that the tabs report to the stored total and, in
// Chrome, opens the offscreen document when a content script can't compile
// WebAssembly under the page's CSP, and closes it when the document says
// it's idle.
import { ADD_SAVED } from '../shared/messages.js';
import { createSaver } from '../shared/stats.js';
import { CLOSE_OFFSCREEN, ENSURE_OFFSCREEN } from '../vad/remote.js';

const api = globalThis.browser ?? globalThis.chrome;
const addSaved = createSaver(api.storage);
let creating = null;

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
