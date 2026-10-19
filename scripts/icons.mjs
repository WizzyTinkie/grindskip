// Renders assets/icons/icon.svg to the PNG sizes the manifests name. The
// PNGs are committed, so building needs no SVG renderer; run this after
// changing the SVG. Needs rsvg-convert (librsvg).
//
// Usage: node scripts/icons.mjs
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 32, 48, 128];

const dir = fileURLToPath(new URL('../assets/icons/', import.meta.url));
for (const size of SIZES) {
  const out = join(dir, `icon-${size}.png`);
  execFileSync('rsvg-convert', ['-w', size, '-h', size, '-o', out, join(dir, 'icon.svg')]);
  console.log(out);
}
