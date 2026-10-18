// The speech detector in Chrome's offscreen document, for pages whose CSP
// stops the content script compiling WebAssembly. Same interface as a local
// Silero stream: process(frame) resolves to the speech probability (NaN for
// frames dropped by a reset), reset() clears the state.
//
// Frames go over a runtime.Port as plain arrays, since Chrome serialises
// extension messages as JSON. If the port drops (the document was closed),
// the next frame reconnects, starting with a fresh state.

export const PORT_NAME = 'grindskip-vad';
export const ENSURE_OFFSCREEN = 'grindskip:ensureOffscreen';
export const CLOSE_OFFSCREEN = 'grindskip:closeOffscreen';
const RETRY_MS = 1000;

export function createRemoteVad(runtime) {
  let port = null;
  let connecting = null;
  let failedAt = -Infinity;
  let lastError = null;
  let nextId = 0;
  const pending = new Map();

  async function connect() {
    const r = await runtime.sendMessage({ type: ENSURE_OFFSCREEN });
    if (!r?.ok) throw new Error(r?.error ?? 'no offscreen document');
    const p = runtime.connect({ name: PORT_NAME });
    p.onMessage.addListener((m) => {
      const done = pending.get(m.id);
      pending.delete(m.id);
      done?.(m);
    });
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      for (const done of pending.values()) done({ error: 'disconnected' });
      pending.clear();
    });
    port = p;
  }

  // Connects unless connected, waiting a second after a failure.
  async function ready() {
    if (port) return;
    if (performance.now() - failedAt < RETRY_MS) throw lastError;
    connecting ??= connect().catch((e) => {
      failedAt = performance.now();
      lastError = e;
      throw e;
    }).finally(() => {
      connecting = null;
    });
    await connecting;
  }

  return {
    ready,
    async process(frame) {
      await ready();
      // The port may have dropped while waiting
      const p = port;
      if (!p) throw new Error('disconnected');
      return new Promise((ok, fail) => {
        const id = nextId++;
        pending.set(id, (m) => (m.error ? fail(new Error(m.error)) : ok(m.p ?? NaN)));
        try {
          p.postMessage({ id, frame: Array.from(frame) });
        } catch (e) {
          pending.delete(id);
          fail(e);
        }
      });
    },
    reset() {
      port?.postMessage({ reset: true });
    },
    release() {
      port?.disconnect();
      port = null;
      for (const done of pending.values()) done({ p: NaN });
      pending.clear();
    },
  };
}
