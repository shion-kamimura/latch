import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test('accepts a prepared environment including a pinned .node-version and type-only dependencies', () => {
  const fakePath = mkdtempSync(join(tmpdir(), 'latch-env-'));
  directories.push(fakePath);
  const executable = join(fakePath, 'pnpm');
  writeFileSync(
    executable,
    '#!/bin/sh\n' +
      '[ "$COREPACK_ENABLE_NETWORK" = "0" ] || exit 1\n' +
      '[ "$npm_config_manage_package_manager_versions" = "false" ] || exit 1\n' +
      'printf "12.14.0\\n"\n',
  );
  chmodSync(executable, 0o755);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../scripts/check-environment.ts', import.meta.url),
      ),
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: fakePath } },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('OK Node.js:');
  expect(result.stdout).toContain('OK 開発依存:');
  expect(result.stdout).toContain('テスト・CI・隔離の安全性は未判定');
  expect(result.stderr).toBe('');
});

test('reports missing pnpm without installing or exposing subprocess errors', () => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'latch-env-'));
  directories.push(emptyPath);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../scripts/check-environment.ts', import.meta.url),
      ),
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: emptyPath } },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('不足 pnpm: 起動できません');
  expect(result.stdout).toContain('pnpm@12.14.0');
  expect(result.stdout).toContain('未実行のテストを成功として扱わない');
  expect(result.stderr).toBe('');
});

test('rejects another pnpm version and does not echo arbitrary command output', () => {
  const fakePath = mkdtempSync(join(tmpdir(), 'latch-env-'));
  directories.push(fakePath);
  const executable = join(fakePath, 'pnpm');
  writeFileSync(executable, '#!/bin/sh\nprintf "secret-example-output\\n"\n');
  chmodSync(executable, 0o755);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../scripts/check-environment.ts', import.meta.url),
      ),
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: fakePath } },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('不足 pnpm:');
  expect(result.stdout + result.stderr).not.toContain('secret-example-output');
});
