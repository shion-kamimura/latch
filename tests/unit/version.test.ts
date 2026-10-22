import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { getVersion } from '../../src/version.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

test('version matches package.json', () => {
  expect(getVersion()).toBe(packageJson.version);
});
