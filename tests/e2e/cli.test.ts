import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const cliPath = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

test('built CLI prints help and exits successfully', () => {
  const result = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: latch [options]');
  expect(result.stdout).toContain('--help');
  expect(result.stdout).toContain('-v, --version');
  expect(result.stderr).toBe('');
});

test.each(['--version', '-v'])(
  'built CLI prints the package version for %s',
  (flag) => {
    const result = spawnSync(process.execPath, [cliPath, flag], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${packageJson.version}\n`);
    expect(result.stderr).toBe('');
  },
);
