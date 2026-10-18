// Chrome's offscreen document: runs the speech detector for content scripts
// that can't (see vad/remote.js). One model for every tab, with a stream
// (its own state) per port. When no tab has used it for a while, it frees
// the model and asks the service worker to close the document.
import { loadModel } from '../vad/load.js';
import { CLOSE_OFFSCREEN, PORT_NAME } from '../vad/remote.js';

const IDLE_MS = 30000;

const api = globalThis.chrome;
let model = null;
let ports = 0;
let idleTimer = null;

api.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports++;
  clearTimeout(idleTimer);
  model ??= loadModel(api.runtime).catch((e) => {
    model = null;
    throw e;
  });
  const stream = model.then((m) => m.createStream());
  let open = true;
  const reply = (msg) => {
    if (open) port.postMessage(msg);
  };

  // Messages are handled in arrival order: each waits for the stream, and
  // the stream queues its frames
  port.onMessage.addListener((msg) => {
    if (msg.reset) {
      stream.then((s) => s.reset(), () => {});
      return;
    }
    stream
      .then((s) => s.process(Float32Array.from(msg.frame)))
      .then((p) => reply({ id: msg.id, p: Number.isNaN(p) ? null : p }))
      .catch((e) => reply({ id: msg.id, error: String(e?.message ?? e) }));
  });
  port.onDisconnect.addListener(() => {
    open = false;
    if (--ports === 0) idleTimer = setTimeout(close, IDLE_MS);
  });
});

async function close() {
  const m = model;
  model = null;
  await m?.then((x) => x.release()).catch(() => {});
  // A tab may have connected in the meantime
  if (ports === 0) api.runtime.sendMessage({ type: CLOSE_OFFSCREEN }).catch(() => {});
}
