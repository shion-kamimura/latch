import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TestRepository {
  readonly root: string;
  git(args: readonly string[]): string;
  write(path: string, content: string | Buffer): void;
  remove(path: string): void;
  symlink(target: string, path: string): void;
  commit(message: string): string;
  cleanup(): void;
}

export function createTestRepository(): TestRepository {
  const root = mkdtempSync(join(tmpdir(), 'latch-verify-test-'));
  const git = (args: readonly string[]): string => {
    const result = spawnSync(
      'git',
      [
        '-c',
        'user.name=Latch Test',
        '-c',
        'user.email=latch@example.com',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
      );
    }
    return result.stdout;
  };
  const write = (path: string, content: string | Buffer): void => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Latch Test']);
  git(['config', 'user.email', 'latch@example.com']);
  write('README.md', '# Fixture\n');
  write('src/a.ts', 'export const value = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  return {
    root,
    git,
    write,
    remove(path) {
      rmSync(join(root, path), { recursive: true, force: true });
    },
    symlink(target, path) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      symlinkSync(target, absolute);
    },
    commit(message) {
      git(['add', '-A']);
      git(['commit', '-q', '-m', message]);
      return git(['rev-parse', 'HEAD']).trim();
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
