import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  { ignores: ['dist/', 'spikes/', 'eval/build/', 'eval/node_modules/', 'eval/.venv/', 'eval/media/', 'eval/recordings/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'eval/ext/**/*.js', 'eval/pages/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.js', 'test/**/*.mjs', 'eval/**/*.mjs', 'eval/lib/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Browser drivers: their page.evaluate() callbacks run in the page
    files: ['eval/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]);
