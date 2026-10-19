import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY, createSaver, duration, load } from '../src/shared/stats.js';

// storage.local whose reads and writes take a turn of the event loop, so
// that overlapping read-modify-writes would lose additions
function slowStorage() {
  const data = {};
  const later = () => new Promise((ok) => setTimeout(ok, 1));
  return {
    data,
    local: {
      async get(key) {
        await later();
        return key in data ? { [key]: structuredClone(data[key]) } : {};
      },
      async set(items) {
        await later();
        Object.assign(data, structuredClone(items));
      },
    },
  };
}

test('additions from several tabs at once all count', async () => {
  const storage = slowStorage();
  assert.equal((await load(storage)).savedSec, 0);
  const add = createSaver(storage);
  await Promise.all([add(1.5), add(2), add(-0.5), add(10)]);
  assert.equal(storage.data[KEY].savedSec, 13);
  assert.equal((await load(storage)).savedSec, 13);
});

test('a damaged total starts again from 0', async () => {
  const storage = slowStorage();
  storage.data[KEY] = { savedSec: 'lots' };
  assert.equal((await load(storage)).savedSec, 0);
});

test('durations read as seconds, minutes or hours', () => {
  assert.equal(duration(0), '0 s');
  assert.equal(duration(-0.4), '0 s');
  assert.equal(duration(42.4), '42 s');
  assert.equal(duration(252), '4 min 12 s');
  assert.equal(duration(4980), '1 h 23 min');
  assert.equal(duration(-75), '−1 min 15 s');
});
