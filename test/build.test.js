import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));
// silero_vad_16k_op15.onnx (v6.2) from snakers4/silero-vad at bfdc019
const MODEL_SHA256 = '7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49';

let out;
before(() => {
  out = mkdtempSync(join(tmpdir(), 'grindskip-build-'));
  execFileSync(process.execPath, [build, '--out', out], { stdio: 'pipe' });
});
after(() => rmSync(out, { recursive: true, force: true }));

// Every file the manifest names, with its path relative to the build
function referencedFiles(m) {
  return [
    ...m.content_scripts.flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
    ...m.web_accessible_resources.flatMap((r) => r.resources),
    ...(m.background?.service_worker ? [m.background.service_worker] : []),
    ...(m.background?.scripts ?? []),
    ...(m.action?.default_popup ? [m.action.default_popup] : []),
    ...Object.values(m.icons ?? {}),
    ...Object.values(m.action?.default_icon ?? {}),
  ];
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} build contains every file its manifest names`, () => {
    const dir = join(out, browser);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    for (const f of referencedFiles(m)) assert.ok(existsSync(join(dir, f)), `${browser}: missing ${f}`);
  });

  test(`${browser} build ships the pinned Silero v6.2 16 kHz model`, () => {
    const hash = createHash('sha256').update(readFileSync(join(out, browser, 'silero_vad.onnx'))).digest('hex');
    assert.equal(hash, MODEL_SHA256);
  });
}

test('only Chrome gets the offscreen document', () => {
  assert.ok(existsSync(join(out, 'chrome', 'offscreen.html')));
  assert.ok(existsSync(join(out, 'chrome', 'offscreen.js')));
  assert.ok(!existsSync(join(out, 'firefox', 'offscreen.html')));
});
