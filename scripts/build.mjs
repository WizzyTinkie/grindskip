// Builds the extension into dist/chrome and dist/firefox.
//
// Usage: node scripts/build.mjs [--watch] [--out dir] [--eval]
//   --watch  rebuild whenever src/, manifest/ or assets/ change
//   --out    write <dir>/chrome and <dir>/firefox instead of dist/
//   --eval   the evaluation build (eval/ext/content.js as the content
//            script, which test drivers can control) into eval/build/
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestFor } from './manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// Per browser: the bundled scripts (output name -> entry point) and the
// files copied as they are (output name -> source). The manifests in
// manifest/ refer to the output names.
const targets = {
  chrome: {
    scripts: {
      'background.js': 'src/background/background.js',
      'offscreen.js': 'src/offscreen/offscreen.js',
    },
    files: { 'offscreen.html': 'src/offscreen/offscreen.html' },
  },
  firefox: {
    scripts: {},
    files: {},
  },
};
const sharedScripts = {
  'content.js': 'src/content/main.js',
  'popup.js': 'src/popup/popup.js',
};
const sharedFiles = {
  'popup.html': 'src/popup/popup.html',
  'popup.css': 'src/popup/popup.css',
  'ort-wasm-simd-threaded.wasm': 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'silero_vad.onnx': 'assets/silero_vad.onnx',
};

async function buildAll(outRoot, { clean, evalBuild }) {
  const contentEntry = evalBuild ? { 'content.js': 'eval/ext/content.js' } : {};
  for (const [browser, { scripts, files }] of Object.entries(targets)) {
    const dir = join(outRoot, browser);
    // Watch rebuilds keep the directory, so that `web-ext run` keeps
    // watching it; a file dropped from the build then stays until the next
    // full build.
    if (clean) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: Object.entries({ ...sharedScripts, ...scripts, ...contentEntry }).map(([out, src]) => ({ in: src, out: out.replace(/\.js$/, '') })),
      bundle: true,
      format: 'iife',
      target: 'es2022',
      // Unminified, so store reviewers can read the bundle
      minify: false,
      outdir: dir,
      logLevel: 'warning',
    });
    for (const [out, src] of Object.entries({ ...sharedFiles, ...files })) {
      cpSync(join(root, src), join(dir, out));
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestFor(browser, root), null, 2) + '\n');
    console.log(`${dir}: ${(dirBytes(dir) / 1e6).toFixed(1)} MB unpacked`);
  }
}

function dirBytes(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => statSync(join(dir, f)))
    .filter((s) => s.isFile())
    .reduce((sum, s) => sum + s.size, 0);
}

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const evalBuild = args.includes('--eval');
const outRoot = oi >= 0 ? resolve(args[oi + 1]) : join(root, evalBuild ? 'eval/build' : 'dist');

if (!args.includes('--watch')) {
  await buildAll(outRoot, { clean: true, evalBuild });
} else {
  // A failed build is reported and the watch goes on
  const report = (e) => console.error(e.message);
  await buildAll(outRoot, { clean: true, evalBuild }).catch(report);
  let timer = null;
  let running = Promise.resolve();
  const rebuild = () => {
    running = running.then(() => buildAll(outRoot, { clean: false, evalBuild })).catch(report);
  };
  for (const dir of ['src', 'manifest', 'assets']) {
    watch(join(root, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 100);
    });
  }
  console.log('Watching src/, manifest/ and assets/');
}
