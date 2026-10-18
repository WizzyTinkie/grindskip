// Builds the spike extension into build/chrome and build/firefox.
//
// Usage: node scripts/build-ext.mjs [--no-wasm-csp] [--models a,b] [--out dir]
//   --no-wasm-csp  leave 'wasm-unsafe-eval' out of the CSP, to see whether
//                  the content script needs it
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const wasmCsp = !args.includes('--no-wasm-csp');
const mi = args.indexOf('--models');
const models = mi >= 0 ? args[mi + 1].split(',') : ['silero_vad_v6.2_16k', 'silero_vad_v5.1.2'];
const oi = args.indexOf('--out');
const out = oi >= 0 ? args[oi + 1] : wasmCsp ? 'build' : 'build-nocsp';

const base = {
  manifest_version: 3,
  name: 'Grindskip spike',
  version: '0.0.1',
  description: 'Phase 0 spike: ONNX Runtime Web + Silero VAD in a content script',
  content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }],
  web_accessible_resources: [{
    resources: ['ort-wasm-simd-threaded.wasm', 'models/*.onnx'],
    matches: ['<all_urls>'],
  }],
  host_permissions: ['<all_urls>'],
};
if (wasmCsp) {
  base.content_security_policy = { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" };
}
const perBrowser = {
  chrome: { background: { service_worker: 'background.js' }, permissions: ['offscreen'] },
  firefox: {
    background: { scripts: ['background.js'] },
    browser_specific_settings: { gecko: { id: 'spike@grindskip.invalid', strict_min_version: '128.0' } },
  },
};

for (const [browser, extra] of Object.entries(perBrowser)) {
  const dir = `${out}/${browser}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/models`, { recursive: true });
  await esbuild.build({
    entryPoints: ['ext/content.js', 'ext/background.js', 'ext/offscreen.js'],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    outdir: dir,
    logLevel: 'warning',
  });
  cpSync('ext/offscreen.html', `${dir}/offscreen.html`);
  cpSync('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', `${dir}/ort-wasm-simd-threaded.wasm`);
  for (const m of models) cpSync(`models/${m}.onnx`, `${dir}/models/${m}.onnx`);
  writeFileSync(`${dir}/manifest.json`, JSON.stringify({ ...base, ...extra }, null, 2));
  const size = execSync(`du -sb ${dir} | cut -f1`).toString().trim();
  console.log(`${dir}: ${(size / 1e6).toFixed(2)} MB unpacked`);
}
