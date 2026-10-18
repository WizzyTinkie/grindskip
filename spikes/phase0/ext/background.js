// Chrome: the service worker. Firefox: the background (event) page.
// Serves inference on the 'vad-bg' port and, in Chrome, opens the
// offscreen document on request.
import { serve } from './remote.js';

serve('vad-bg');

const api = globalThis.browser ?? globalThis.chrome;
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ensureOffscreen') return;
  (async () => {
    if (!api.offscreen) throw new Error('no offscreen API');
    if (!(await api.offscreen.hasDocument())) {
      await api.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Runs the speech-detection model for the video in the active tab',
      });
    }
  })().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
