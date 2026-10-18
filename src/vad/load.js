// Loads Silero in an extension's script context (the content script or the
// offscreen document), with ONNX Runtime fetching its .wasm by URL: that
// also works in Firefox content scripts, and uses 20-40 MB less memory than
// handing it the bytes.
import * as ort from 'onnxruntime-web/wasm';
import { createModel } from './silero.js';

export async function loadModel(runtime) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { wasm: runtime.getURL('ort-wasm-simd-threaded.wasm') };
  ort.env.logLevel = 'error';
  const res = await fetch(runtime.getURL('silero_vad.onnx'));
  if (!res.ok) throw new Error(`silero_vad.onnx: HTTP ${res.status}`);
  // In a Firefox content script the fetched buffer belongs to the page, and
  // ORT's `instanceof Uint8Array` check rejects it, so copy it into our own
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(new Uint8Array(buffer));
  return createModel(ort, bytes);
}

// Whether this context may compile WebAssembly. Chrome applies the page's
// CSP to content scripts here, so on pages without 'unsafe-eval' or
// 'wasm-unsafe-eval' it can't, and the model has to run in the offscreen
// document instead.
export function canCompileWasm() {
  try {
    new WebAssembly.Module(Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0));
    return true;
  } catch {
    return false;
  }
}
