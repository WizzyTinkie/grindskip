import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { manifestFor, merge } from '../scripts/manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

test('merge concatenates arrays, merges objects and replaces other values', () => {
  const base = { a: [1], b: { x: 1, y: [2] }, c: 'base', d: { z: 1 } };
  const extra = { a: [3], b: { y: [4], w: 5 }, c: 'extra', d: 'scalar', e: true };
  assert.deepEqual(merge(base, extra), {
    a: [1, 3], b: { x: 1, y: [2, 4], w: 5 }, c: 'extra', d: 'scalar', e: true,
  });
  assert.deepEqual(base, { a: [1], b: { x: 1, y: [2] }, c: 'base', d: { z: 1 } });
});

test('Chrome gets the offscreen permission and a service worker', () => {
  const m = manifestFor('chrome', root);
  assert.equal(m.manifest_version, 3);
  assert.equal(m.version, version);
  assert.ok(m.permissions.includes('storage'));
  assert.ok(m.permissions.includes('offscreen'));
  assert.equal(m.background.service_worker, 'background.js');
  assert.equal(m.browser_specific_settings, undefined);
});

test('Chrome lets the offscreen document compile WebAssembly', () => {
  // The default MV3 policy for extension pages doesn't
  const csp = manifestFor('chrome', root).content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
});

test('both have a popup', () => {
  for (const browser of ['chrome', 'firefox']) {
    assert.equal(manifestFor(browser, root).action.default_popup, 'popup.html', browser);
  }
});

test('both have the icon in every size, for the toolbar too', () => {
  for (const browser of ['chrome', 'firefox']) {
    const m = manifestFor(browser, root);
    assert.deepEqual(Object.keys(m.icons), ['16', '32', '48', '128'], browser);
    // Gray: Grindskip starts off, and the background script turns it green
    assert.deepEqual(m.action.default_icon, { 16: 'icon-off-16.png', 32: 'icon-off-32.png' }, browser);
  }
});

test('both have the shortcut to turn Grindskip on or off', () => {
  for (const browser of ['chrome', 'firefox']) {
    const m = manifestFor(browser, root);
    assert.equal(m.commands.toggle.suggested_key.default, 'Alt+Shift+G', browser);
    // The background script handles it
    assert.ok(m.background, browser);
  }
});

test('Firefox gets a fixed add-on ID, requires version 149 and has an event page', () => {
  const m = manifestFor('firefox', root);
  assert.equal(m.version, version);
  assert.match(m.browser_specific_settings.gecko.id, /^[\w.-]+@[\w.-]+$/);
  assert.equal(m.browser_specific_settings.gecko.strict_min_version, '149.0');
  assert.deepEqual(m.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
  assert.ok(!m.permissions.includes('offscreen'));
  assert.deepEqual(m.background, { scripts: ['background.js'] });
});

test('both expose the ONNX Runtime WebAssembly and the model to the content script', () => {
  for (const browser of ['chrome', 'firefox']) {
    const m = manifestFor(browser, root);
    const war = m.web_accessible_resources.flatMap((r) => r.resources);
    assert.ok(war.includes('ort-wasm-simd-threaded.wasm'), browser);
    assert.ok(war.includes('silero_vad.onnx'), browser);
    const contentMatches = m.content_scripts.flatMap((c) => c.matches);
    for (const r of m.web_accessible_resources) assert.deepEqual(r.matches, contentMatches, browser);
  }
});
