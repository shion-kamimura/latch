import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const cliPath = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));

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
  expect(result.stderr).toBe('');
});
