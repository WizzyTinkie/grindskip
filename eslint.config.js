import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  { ignores: ['dist/', 'spikes/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
]);
