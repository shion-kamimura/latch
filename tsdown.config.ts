import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  platform: 'node',
  target: 'node26',
  format: 'esm',
  outExtensions: () => ({ js: '.mjs' }),
  clean: true,
});
