import { afterEach, describe, expect, test, vi } from 'vitest';
import { runCli } from '../../src/run-cli.js';
import {
  createTestRepository,
  type TestRepository,
} from '../helpers/repository.js';

const repositories: TestRepository[] = [];

function repository(): TestRepository {
  const repo = createTestRepository();
  repositories.push(repo);
  repo.write('issue.md', '# Verify issue\n\n- a requirement\n');
  repo.commit('add issue');
  repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return repo;
}

function run(args: string[], root: string) {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  const status = runCli(args, io, { cwd: root });
  return { status, io };
}

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.cleanup();
});

describe('verify command input resolution', () => {
  test('prints a JSON input snapshot without claiming requirement verification', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');

    const { status, io } = run(
      ['verify', '--base', 'origin/main', '--issue-file', 'issue.md', '--json'],
      repo.root,
    );

    expect(status).toBe(0);
    expect(io.stderr).not.toHaveBeenCalled();
    const snapshot = JSON.parse(io.stdout.mock.calls[0]?.[0] as string) as {
      phase: string;
      verification: string;
      diff: { files: { path: string; kind: string }[] };
    };
    expect(snapshot.phase).toBe('input-resolution');
    expect(snapshot.verification).toBe('not-run');
    expect(snapshot.diff.files).toEqual([
      expect.objectContaining({ path: 'src/a.ts', kind: 'committed' }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('検証成功');
  });

  test('prints a text report with warnings and no verification completion claim', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');
    repo.write('src/untracked.ts', 'export const untracked = true;\n');

    const { status, io } = run(
      ['verify', '--base', 'origin/main', '--issue-file', 'issue.md'],
      repo.root,
    );

    expect(status).toBe(0);
    const output = io.stdout.mock.calls[0]?.[0] as string;
    expect(output).toContain('Latch input resolution');
    expect(output).toContain('コミット済みの変更');
    expect(output).toContain('入力の解決のみを行いました');
    expect(output).not.toContain('検証成功');
    expect(output).not.toContain('検証完了');
    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('--include-untracked'),
    );
  });

  test('returns exit code 1 and guidance when the issue file is missing', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');

    const { status, io } = run(
      ['verify', '--base', 'origin/main', '--issue-file', 'missing.md'],
      repo.root,
    );

    expect(status).toBe(1);
    expect(io.stdout).not.toHaveBeenCalled();
    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('--issue-file'),
    );
  });

  test('returns exit code 1 when the diff is empty', () => {
    const repo = repository();
    repo.write('src/untracked.ts', 'export const untracked = true;\n');

    const { status, io } = run(
      ['verify', '--base', 'origin/main', '--issue-file', 'issue.md'],
      repo.root,
    );

    expect(status).toBe(1);
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('差分が空'));
  });

  test('returns exit code 1 for an invalid base ref', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');

    const { status, io } = run(
      ['verify', '--base', 'missing-ref', '--issue-file', 'issue.md'],
      repo.root,
    );

    expect(status).toBe(1);
    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('比較対象ref'),
    );
  });

  test('returns exit code 2 for unsupported GitHub issue fetching', () => {
    const repo = repository();
    const { status, io } = run(['verify', '--issue', '23'], repo.root);
    expect(status).toBe(2);
    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('--issue-file'),
    );
  });

  test('shows help for verify --help', () => {
    const repo = repository();
    const { status, io } = run(['verify', '--help'], repo.root);
    expect(status).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(
      expect.stringContaining('--include-untracked'),
    );
  });
});
