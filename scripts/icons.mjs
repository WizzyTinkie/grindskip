// Renders assets/icons/icon.svg to the PNG sizes the manifests name, in
// green, and the toolbar sizes again in gray for while Grindskip is off
// (icon-off-*.png, the same icon with the green swapped). The PNGs are
// committed, so building needs no SVG renderer; run this after changing the
// SVG. Needs rsvg-convert (librsvg).
//
// Usage: node scripts/icons.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 32, 48, 128];
const TOOLBAR_SIZES = [16, 32];
const GREEN = '#16a34a';
const GRAY = '#8f949c';

const dir = fileURLToPath(new URL('../assets/icons/', import.meta.url));
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');
if (!svg.includes(GREEN)) throw new Error(`icon.svg no longer uses ${GREEN}; update GREEN here`);
const variants = [
  { name: 'icon', source: svg, sizes: SIZES },
  { name: 'icon-off', source: svg.replaceAll(GREEN, GRAY), sizes: TOOLBAR_SIZES },
];

for (const { name, source, sizes } of variants) {
  for (const size of sizes) {
    const out = join(dir, `${name}-${size}.png`);
    // rsvg-convert reads the SVG from stdin
    execFileSync('rsvg-convert', ['-w', size, '-h', size, '-o', out], { input: source });
    console.log(out);
  }
}
