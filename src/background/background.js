// Chrome's service worker: opens the offscreen document when a content
// script can't compile WebAssembly under the page's CSP, and closes it when
// the document says it's idle.
import { CLOSE_OFFSCREEN, ENSURE_OFFSCREEN } from '../vad/remote.js';

const api = globalThis.chrome;
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
