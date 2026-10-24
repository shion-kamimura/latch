import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import {
  createTestRepository,
  type TestRepository,
} from '../helpers/repository.js';

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

const repositories: TestRepository[] = [];

function repository(): TestRepository {
  const repo = createTestRepository();
  repositories.push(repo);
  repo.write('issue.md', '# CLI issue\n\n- a requirement\n');
  repo.commit('add issue');
  repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return repo;
}

function runBuilt(args: string[], root: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.cleanup();
});

test('built CLI resolves inputs as JSON without claiming verification', () => {
  const repo = repository();
  repo.write('src/a.ts', 'export const value = 2;\n');
  repo.commit('change value');

  const result = runBuilt(
    ['verify', '--base', 'origin/main', '--issue-file', 'issue.md', '--json'],
    repo.root,
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const snapshot = JSON.parse(result.stdout) as {
    phase: string;
    verification: string;
  };
  expect(snapshot.phase).toBe('input-resolution');
  expect(snapshot.verification).toBe('not-run');
  expect(result.stdout).not.toContain('検証成功');
});

test('built CLI includes an explicitly named untracked file', () => {
  const repo = repository();
  repo.write('src/new.ts', 'export const added = true;\n');

  const result = runBuilt(
    [
      'verify',
      '--base',
      'origin/main',
      '--issue-file',
      'issue.md',
      '--include-untracked',
      'src/new.ts',
      '--json',
    ],
    repo.root,
  );

  expect(result.status).toBe(0);
  const snapshot = JSON.parse(result.stdout) as {
    diff: { untracked: { path: string }[]; files: unknown[] };
  };
  expect(snapshot.diff.untracked.map((file) => file.path)).toEqual([
    'src/new.ts',
  ]);
  expect(result.stderr).toBe('');
});

test('built CLI warns and fails when only untracked changes exist', () => {
  const repo = repository();
  repo.write('src/untracked.ts', 'export const untracked = true;\n');

  const result = runBuilt(
    ['verify', '--base', 'origin/main', '--issue-file', 'issue.md'],
    repo.root,
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('未追跡ファイル');
  expect(result.stderr).toContain('--include-untracked');
  expect(result.stderr).toContain('差分が空');
  expect(result.stderr).not.toContain('export const untracked');
});

test('built CLI plan fails closed without a permission profile', () => {
  const repo = repository();
  repo.write('src/a.ts', 'export const value = 2;\n');
  repo.commit('change value');

  const result = runBuilt(
    ['plan', '--base', 'origin/main', '--issue-file', 'issue.md'],
    repo.root,
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('--profile');
  expect(result.stderr).toContain('LATCH_PROFILE');
});

test('built CLI returns exit code 1 outside a repository', () => {
  const directory = mkdtempSync(join(tmpdir(), 'latch-not-a-repository-'));
  try {
    const result = runBuilt(['verify', '--issue-file', 'issue.md'], directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Git管理されたリポジトリ');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
