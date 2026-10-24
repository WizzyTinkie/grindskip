import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, KEY, RANGES, VERSION, load, migrate, save, toggle, watch } from '../src/shared/settings.js';

test('nothing stored gives the defaults', () => {
  for (const stored of [undefined, null, 'x', 42, []]) assert.deepEqual(migrate(stored), DEFAULTS);
  assert.equal(DEFAULTS.version, VERSION);
  assert.equal(DEFAULTS.enabled, false);
  assert.equal(DEFAULTS.playSpeed, 2.5);
});

test('defaults are inside their ranges', () => {
  for (const [key, r] of Object.entries(RANGES)) {
    assert.ok(DEFAULTS[key] >= r.min && DEFAULTS[key] <= r.max, key);
  }
});

test('valid values are kept, others replaced by the default', () => {
  const s = migrate({ enabled: true, talkSpeed: 1.25, playSpeed: 'fast', waitSec: NaN, overlay: 1 });
  assert.equal(s.enabled, true);
  assert.equal(s.talkSpeed, 1.25);
  assert.equal(s.playSpeed, DEFAULTS.playSpeed);
  assert.equal(s.waitSec, DEFAULTS.waitSec);
  assert.equal(s.overlay, false);
});

test('numbers are clamped to their range and snapped to its step', () => {
  const s = migrate({ talkSpeed: 0.1, playSpeed: 9, waitSec: 1.3, sensitivity: 0.6 });
  assert.equal(s.talkSpeed, RANGES.talkSpeed.min);
  assert.equal(s.playSpeed, 4);
  assert.equal(s.waitSec, 1.25);
  assert.equal(s.sensitivity, 1);
  assert.equal(migrate({ talkSpeed: 1.1500000000000001 }).talkSpeed, 1.15);
});

test('unknown keys are dropped and the version is current', () => {
  // rewind was a setting until look-ahead made it unnecessary
  const s = migrate({ version: 0, holdSec: 3, rewind: true, extra: true });
  assert.deepEqual(Object.keys(s).sort(), Object.keys(DEFAULTS).sort());
  assert.equal(s.version, VERSION);
});

function fakeStorage(initial = {}) {
  const data = { ...initial };
  const listeners = new Set();
  return {
    data,
    local: {
      async get(key) { return key in data ? { [key]: data[key] } : {}; },
      async set(items) {
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: data[k], newValue: v };
          data[k] = v;
        }
        for (const l of listeners) l(changes, 'local');
      },
    },
    onChanged: { addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l) },
  };
}

test('load, save and watch go through storage.local', async () => {
  const storage = fakeStorage({ [KEY]: { enabled: true, playSpeed: 3 } });
  const s = await load(storage);
  assert.equal(s.enabled, true);
  assert.equal(s.playSpeed, 3);

  const seen = [];
  const stop = watch(storage, (x) => seen.push(x));
  await save(storage, { ...s, playSpeed: 7 });
  assert.equal(storage.data[KEY].playSpeed, 4);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].playSpeed, 4);
  stop();
  await save(storage, s);
  assert.equal(seen.length, 1);
});

test('toggle turns Grindskip on and off and keeps the other settings', async () => {
  const storage = fakeStorage({ [KEY]: { playSpeed: 3 } });
  assert.equal(await toggle(storage), true);
  assert.equal(storage.data[KEY].enabled, true);
  assert.equal(storage.data[KEY].playSpeed, 3);
  assert.equal(await toggle(storage), false);
  assert.equal(storage.data[KEY].enabled, false);
});
