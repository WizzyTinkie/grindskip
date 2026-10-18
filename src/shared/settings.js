// Settings: defaults, ranges, migration and storage. Everything is kept in
// storage.local under one key, with a schema version so that later versions
// can migrate what an older one saved.

export const VERSION = 1;
export const KEY = 'settings';

// Bounds and slider steps for the numeric settings; the popup builds its
// sliders from these.
export const RANGES = {
  talkSpeed: { min: 0.75, max: 2, step: 0.05 },
  playSpeed: { min: 1.25, max: 4, step: 0.25 },
  waitSec: { min: 0.5, max: 5, step: 0.25 },
  sensitivity: { min: -2, max: 2, step: 1 },
};

export const DEFAULTS = Object.freeze({
  version: VERSION,
  enabled: false,
  talkSpeed: 1,       // speed while someone is talking
  playSpeed: 2.5,     // speed while no one is talking
  waitSec: 1.5,       // time without speech before speeding up
  sensitivity: 0,     // higher: quieter or less clear speech also counts
  rewind: false,      // jump back to where the speech started
  overlay: false,     // show the speech meter on the page
});

// Turns whatever was stored (nothing, an older version, values out of range)
// into a complete, valid settings object of the current version.
export function migrate(stored) {
  const s = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  // Version 1 is the first; later versions add their steps here, each
  // taking the object from version n to n + 1.
  const out = { ...DEFAULTS };
  for (const key of ['enabled', 'rewind', 'overlay']) {
    if (typeof s[key] === 'boolean') out[key] = s[key];
  }
  for (const [key, r] of Object.entries(RANGES)) {
    const v = s[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clamp(snap(v, r), r.min, r.max);
  }
  return out;
}

function snap(v, { min, step }) {
  // Round to the slider's step, with the float noise taken out
  return Math.round((min + Math.round((v - min) / step) * step) * 1000) / 1000;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// storage is browser.storage / chrome.storage: both return promises in MV3.
export async function load(storage) {
  const data = await storage.local.get(KEY);
  return migrate(data[KEY]);
}

export function save(storage, settings) {
  return storage.local.set({ [KEY]: migrate(settings) });
}

// Calls onChange(settings) whenever the stored settings change; returns a
// function that stops listening.
export function watch(storage, onChange) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[KEY]) onChange(migrate(changes[KEY].newValue));
  };
  storage.onChanged.addListener(listener);
  return () => storage.onChanged.removeListener(listener);
}
