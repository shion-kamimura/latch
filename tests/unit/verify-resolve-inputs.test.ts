import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { VerificationInputError } from '../../src/verify/errors.js';
import { resolveVerificationInputs } from '../../src/verify/resolve-inputs.js';
import {
  createTestRepository,
  type TestRepository,
} from '../helpers/repository.js';

const repositories: TestRepository[] = [];

function repository(): TestRepository {
  const repo = createTestRepository();
  repositories.push(repo);
  repo.write('issue.md', '# Test issue\n\n- required behavior\n');
  repo.commit('add issue');
  repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return repo;
}

function resolve(
  repo: TestRepository,
  options: Partial<{
    base: string;
    issueFile: string;
    includeUntracked: string[];
    json: boolean;
  }> = {},
) {
  return resolveVerificationInputs(
    {
      base: options.base ?? 'origin/main',
      issueFile: options.issueFile ?? 'issue.md',
      includeUntracked: options.includeUntracked ?? [],
      json: options.json ?? false,
    },
    repo.root,
  );
}

function expectInputError(callback: () => unknown): VerificationInputError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(VerificationInputError);
    return error as VerificationInputError;
  }
  throw new Error('expected a verification input error');
}

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.cleanup();
});

describe('verification input resolution', () => {
  test('excludes credential locations from tracked and explicit untracked input', () => {
    const repo = repository();
    repo.write('.claude/auth.json', 'credential-file-sentinel');
    repo.write('.env', 'ENV=credential-file-sentinel');
    repo.write('src/a.ts', 'export const value = 2;');
    repo.commit('change with unsafe paths');
    repo.write('.codex/auth.json', 'untracked-credential-sentinel');
    const snapshot = resolve(repo, { includeUntracked: ['.codex/auth.json'] });
    expect(JSON.stringify(snapshot)).not.toContain('credential-file-sentinel');
    expect(JSON.stringify(snapshot)).not.toContain(
      'untracked-credential-sentinel',
    );
    expect(
      snapshot.diff.excluded.filter((entry) => entry.reason === 'credential'),
    ).toHaveLength(3);
    expect(() => resolve(repo, { issueFile: '.claude/auth.json' })).toThrow(
      '認証情報',
    );
    repo.symlink('.claude', 'alias');
    expect(() => resolve(repo, { issueFile: 'alias/auth.json' })).toThrow(
      '認証情報',
    );
  });

  test('resolves committed and uncommitted changes separately', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');
    repo.write('README.md', '# Fixture changed\n');

    const snapshot = resolve(repo);

    expect(snapshot.phase).toBe('input-resolution');
    expect(snapshot.verification).toBe('not-run');
    expect(snapshot.base).toMatchObject({
      ref: 'origin/main',
      requested: 'origin/main',
      usedDefault: false,
    });
    expect(
      snapshot.diff.files.map((file) => ({
        path: file.path,
        kind: file.kind,
        status: file.status,
      })),
    ).toEqual([
      { path: 'src/a.ts', kind: 'committed', status: 'M' },
      { path: 'README.md', kind: 'uncommitted', status: 'M' },
    ]);
    expect(snapshot.diff.committed).toContain('src/a.ts');
    expect(snapshot.diff.uncommitted).toContain('README.md');
    expect(snapshot.reproducibility.ciReproducible).toBe(false);
    expect(snapshot.reproducibility.notes.join('\n')).toContain('未コミット');
  });

  test('excludes untracked files by default, warns, and retains the boundary', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');
    repo.write('src/untracked.ts', 'export const untracked = true;\n');

    const snapshot = resolve(repo);

    expect(snapshot.diff.untracked).toEqual([]);
    expect(snapshot.diff.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(snapshot.warnings.join('\n')).toContain('未追跡ファイル 1 件');
    expect(snapshot.warnings.join('\n')).toContain('src/untracked.ts');
    expect(snapshot.reproducibility.ciReproducible).toBe(true);
  });

  test('includes only explicitly named untracked files', () => {
    const repo = repository();
    repo.write('src/new.ts', 'export const added = 1;\n');
    repo.write('src/other.ts', 'export const other = 1;\n');

    const snapshot = resolve(repo, { includeUntracked: ['src/new.ts'] });

    expect(snapshot.diff.untracked).toEqual([
      expect.objectContaining({
        path: 'src/new.ts',
        content: 'export const added = 1;\n',
      }),
    ]);
    expect(snapshot.warnings.join('\n')).toContain('src/other.ts');
    expect(snapshot.warnings.join('\n')).not.toContain('src/new.ts');
    expect(snapshot.reproducibility.ciReproducible).toBe(false);
    expect(snapshot.reproducibility.notes.join('\n')).toContain('未追跡');
  });

  test('rejects an empty diff and points to explicit untracked inclusion', () => {
    const repo = repository();
    repo.write('src/untracked.ts', 'export const untracked = true;\n');

    const error = expectInputError(() => resolve(repo));

    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('差分が空');
    expect(error.guidance).toContain('--include-untracked');
  });

  test('rejects an unknown base ref without guessing', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');

    const error = expectInputError(() =>
      resolve(repo, { base: 'does-not-exist' }),
    );

    expect(error.exitCode).toBe(1);
    expect(error.guidance).toContain('--base');
  });

  test('resolves the documented default base', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');

    const snapshot = resolveVerificationInputs(
      { issueFile: 'issue.md', includeUntracked: [], json: false },
      repo.root,
    );

    expect(snapshot.base).toMatchObject({
      ref: 'origin/main',
      requested: null,
      usedDefault: true,
    });
  });

  test('does not guess when no default base can be resolved', () => {
    const repo = repository();
    repo.git(['checkout', '-q', '-b', 'feature']);
    repo.git(['branch', '-D', 'main']);
    repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');

    const error = expectInputError(() =>
      resolveVerificationInputs(
        { issueFile: 'issue.md', includeUntracked: [], json: false },
        repo.root,
      ),
    );

    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('既定の比較対象');
    expect(error.guidance).toContain('--base');
  });

  test('compares from the merge base instead of unrelated base movement', () => {
    const repo = repository();
    repo.git(['checkout', '-q', '-b', 'feature']);
    repo.write('src/feature.ts', 'export const feature = true;\n');
    repo.commit('feature change');
    repo.git(['checkout', '-q', 'main']);
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('main change');
    repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    repo.git(['checkout', '-q', 'feature']);

    const snapshot = resolve(repo);

    expect(snapshot.diff.files.map((file) => file.path)).toEqual([
      'src/feature.ts',
    ]);
    expect(snapshot.base.mergeBase).not.toBe(snapshot.base.commit);
  });

  test('excludes binary and symlink changes with reasons', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.write('data.bin', Buffer.from([0, 1, 2, 3]));
    repo.symlink('README.md', 'link.ts');
    repo.commit('binary and symlink');

    const snapshot = resolve(repo);

    expect(snapshot.diff.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(snapshot.diff.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'data.bin', reason: 'binary' }),
        expect.objectContaining({ path: 'link.ts', reason: 'symlink' }),
      ]),
    );
  });

  test('rejects .git and boundary escape attempts for untracked paths', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');
    const outside = join(repo.root, '..', 'outside-secret.txt');

    const snapshot = resolve(repo, {
      includeUntracked: ['.git/config', outside],
    });

    expect(snapshot.diff.untracked).toEqual([]);
    expect(snapshot.diff.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.git/config',
          reason: 'git-internal',
        }),
        expect.objectContaining({
          path: outside,
          reason: 'outside-boundary',
        }),
      ]),
    );
  });

  test('excludes binary untracked files even when explicitly requested', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');
    repo.write('src/blob.ts', Buffer.from([0, 1, 2]));

    const snapshot = resolve(repo, { includeUntracked: ['src/blob.ts'] });

    expect(snapshot.diff.untracked).toEqual([]);
    expect(snapshot.diff.excluded).toContainEqual(
      expect.objectContaining({
        path: 'src/blob.ts',
        reason: 'binary',
      }),
    );
  });

  test('rejects a missing, empty, malformed, symlinked, or non-UTF8 issue file', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');

    expect(
      expectInputError(() => resolve(repo, { issueFile: 'missing.md' }))
        .message,
    ).toContain('見つかりません');

    repo.write('empty.md', '  \n');
    expect(
      expectInputError(() => resolve(repo, { issueFile: 'empty.md' })).message,
    ).toContain('空');

    repo.write('malformed.md', 'No heading here\n');
    expect(
      expectInputError(() => resolve(repo, { issueFile: 'malformed.md' }))
        .message,
    ).toContain('形式が不正');

    repo.write('binary.md', Buffer.from([0xff, 0xfe, 0x00]));
    expect(
      expectInputError(() => resolve(repo, { issueFile: 'binary.md' })).message,
    ).toMatch(/UTF-8|テキスト/);

    repo.symlink('issue.md', 'link.md');
    expect(
      expectInputError(() => resolve(repo, { issueFile: 'link.md' })).message,
    ).toContain('シンボリックリンク');
  });

  test('keeps issue state and source without rejecting a closed issue', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');
    repo.write(
      'closed-issue.md',
      '---\nstate: closed\nsource: https://example.test/issues/22\n---\n\n# Closed issue\n\n- past requirement\n',
    );

    const snapshot = resolve(repo, { issueFile: 'closed-issue.md' });

    expect(snapshot.issue).toMatchObject({
      title: 'Closed issue',
      state: 'closed',
      source: 'https://example.test/issues/22',
    });
    expect(snapshot.issue?.content).toContain('past requirement');
  });

  test('keeps the snapshot digest stable and changes it with input content', () => {
    const repo = repository();
    repo.write('src/new.ts', 'export const value = 1;\n');

    const first = resolve(repo, { includeUntracked: ['src/new.ts'] });
    const second = resolve(repo, { includeUntracked: ['src/new.ts'] });
    expect(second.digest).toBe(first.digest);

    repo.write('src/new.ts', 'export const value = 2;\n');
    const third = resolve(repo, { includeUntracked: ['src/new.ts'] });
    expect(third.digest).not.toBe(first.digest);
  });

  test('does not modify the source or issue files', () => {
    const repo = repository();
    repo.write('src/a.ts', 'export const value = 2;\n');
    repo.commit('change value');
    const source = readFileSync(join(repo.root, 'src/a.ts'), 'utf8');
    const issue = readFileSync(join(repo.root, 'issue.md'), 'utf8');

    resolve(repo);

    expect(readFileSync(join(repo.root, 'src/a.ts'), 'utf8')).toBe(source);
    expect(readFileSync(join(repo.root, 'issue.md'), 'utf8')).toBe(issue);
  });
});
