// Spike 1 fallback: Silero in an extension context instead of the content
// script, for pages whose CSP stops the content script compiling
// WebAssembly (Chrome applies the page's CSP there). A content script
// connects a runtime.Port with the given name and sends frames; each port
// gets its own recurrent state.
import * as ort from 'onnxruntime-web/wasm';
import { createSilero } from '../lib/silero.js';

const api = globalThis.browser ?? globalThis.chrome;
const MODEL = 'silero_vad_v6.2_16k';

let modelBytes = null;
async function newVad() {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { wasm: api.runtime.getURL('ort-wasm-simd-threaded.wasm') };
  modelBytes ??= new Uint8Array(await (await fetch(api.runtime.getURL(`models/${MODEL}.onnx`))).arrayBuffer());
  return createSilero(ort, modelBytes);
}

export function serve(portName) {
  api.runtime.onConnect.addListener((port) => {
    if (port.name !== portName) return;
    const t0 = performance.now();
    const vadP = newVad();
    let queue = Promise.resolve();
    port.onMessage.addListener((msg) => {
      queue = queue.then(async () => {
        const vad = await vadP;
        if (msg.hello) {
          port.postMessage({ id: msg.id, initMs: performance.now() - t0, where: portName, ua: navigator.userAgent });
          return;
        }
        const t = performance.now();
        const p = await vad.process(Float32Array.from(msg.frame));
        port.postMessage({ id: msg.id, p, inferMs: performance.now() - t });
      }).catch((e) => port.postMessage({ id: msg.id, error: `${e?.name}: ${e?.message ?? e}` }));
    });
    port.onDisconnect.addListener(() => { vadP.then((v) => v.release()).catch(() => {}); });
  });
}
