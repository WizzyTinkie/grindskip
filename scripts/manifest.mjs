// Builds each browser's manifest.json from manifest/base.json plus
// manifest/<browser>.json, with the version taken from package.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Objects merge key by key and arrays are concatenated; any other value in
// `extra` replaces the one in `base`.
export function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const prev = out[key];
    if (Array.isArray(prev) && Array.isArray(value)) out[key] = [...prev, ...value];
    else if (isObject(prev) && isObject(value)) out[key] = merge(prev, value);
    else out[key] = value;
  }
  return out;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function manifestFor(browser, root) {
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(join(root, path), 'utf8'));
    } catch (e) {
      throw new Error(`${path}: ${e.message}`, { cause: e });
    }
  };
  const { version } = read('package.json');
  return { ...merge(read('manifest/base.json'), read(`manifest/${browser}.json`)), version };
}
