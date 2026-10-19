// The time saved in all, kept in storage.local next to the settings. Only
// the background script adds to it, one addition at a time, so that tabs
// adding at once don't overwrite each other's.

export const KEY = 'stats';

export function migrate(stored) {
  const v = stored?.savedSec;
  return { savedSec: typeof v === 'number' && Number.isFinite(v) ? v : 0 };
}

export async function load(storage) {
  const data = await storage.local.get(KEY);
  return migrate(data[KEY]);
}

// Returns add(seconds), which adds to the stored total; the additions run
// one after another.
export function createSaver(storage) {
  let chain = Promise.resolve();
  return (seconds) => {
    chain = chain.then(async () => {
      const s = await load(storage);
      await storage.local.set({ [KEY]: { savedSec: s.savedSec + seconds } });
    }).catch((e) => console.warn('Grindskip:', e));
    return chain;
  };
}

// For display: 42 s, 4 min 12 s, 1 h 23 min
export function duration(sec) {
  const s = Math.round(Math.abs(sec));
  const sign = sec < 0 && s > 0 ? '−' : '';
  if (s < 60) return `${sign}${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${sign}${m} min ${s % 60} s`;
  return `${sign}${Math.floor(m / 60)} h ${m % 60} min`;
}
