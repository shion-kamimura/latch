import { isCredentialPath } from '../verify/paths.js';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isEvaluationArtifactPath } from '../plan/test-candidates.js';
import { RequirementPlanError } from '../plan/errors.js';
import type { ExecutionSettings } from '../plan/types.js';
import { toPosixPath, isInside } from '../verify/paths.js';
import type { IsolationWorkspace, VerificationInputSnapshot } from './types.js';

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function isolationError(message: string, guidance: string): never {
  throw new RequirementPlanError(message, guidance);
}

export function assertIsolationSupported(): void {
  const flags = process.allowedNodeEnvironmentFlags;
  if (
    !flags.has('--permission') ||
    !flags.has('--allow-fs-read') ||
    !flags.has('--allow-fs-write') ||
    !flags.has('--allow-worker')
  ) {
    isolationError(
      'このNode.jsでは隔離実行に必要なパーミッションモデルを利用できません。',
      'Node.js 26で実行してください。隔離が使えない状態で対象コードをホスト実行しません。',
    );
  }
}

export function sanitizedEnvironment(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C',
    LC_ALL: 'C',
    TZ: process.env.TZ ?? 'UTC',
    HOME: home,
    TMPDIR: temp,
    NO_COLOR: '1',
    CI: '1',
    NODE_ENV: 'test',
  };
}

function runnerInfo(): { runnerPath: string; nodeModules: string } {
  const require = createRequire(import.meta.url);
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve('vitest/package.json');
  } catch {
    isolationError(
      '隔離実行に使うVitestが見つかりませんでした。',
      '依存関係を準備してから再実行してください。対象コードをホスト直接実行しません。',
    );
  }
  const packageRoot = dirname(packageJsonPath);
  const runnerPath = join(packageRoot, 'vitest.mjs');
  if (!existsSync(runnerPath)) {
    isolationError(
      '隔離実行に使うVitestのエントリーポイントが見つかりませんでした。',
      '依存関係を準備してから再実行してください。',
    );
  }

  let current = packageRoot;
  let nodeModules = packageRoot;
  for (let depth = 0; depth < 12; depth += 1) {
    if (
      basename(current) === 'node_modules' &&
      basename(dirname(dirname(current))) !== '.pnpm'
    ) {
      nodeModules = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { runnerPath, nodeModules };
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: Error | null;
} {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: Math.max(options.maxOutputBytes * 2, 1024 * 1024),
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut:
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    error: result.error ?? null,
  };
}

function countFiles(root: string): number {
  let count = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(join(directory, entry.name));
      else if (entry.isFile()) count += 1;
    }
  };
  visit(root);
  return count;
}

function pruneEvaluationArtifacts(workDir: string): {
  excluded: string[];
  removed: number;
} {
  const excluded: string[] = [];
  let removed = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = toPosixPath(relative(workDir, absolute));
      if (
        isEvaluationArtifactPath(relativePath) ||
        isCredentialPath(relativePath)
      ) {
        excluded.push(relativePath);
        removed += 1;
        rmSync(absolute, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
    }
  };
  visit(workDir);
  return { excluded, removed };
}

function writeSafeFile(workDir: string, path: string, content: string): void {
  const absolute = resolve(workDir, path);
  if (
    !isInside(workDir, absolute) ||
    path.split('/').includes('..') ||
    path.startsWith('/')
  ) {
    isolationError(
      '入力スナップショットに隔離領域外を指すパスがあります。',
      '未追跡ファイルの指定を確認してください。',
    );
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function applyUncommitted(
  workDir: string,
  snapshot: VerificationInputSnapshot,
  env: NodeJS.ProcessEnv,
  settings: ExecutionSettings,
): void {
  if (snapshot.diff.uncommitted.length === 0) return;
  const result = runCommand('git', ['apply', '--whitespace=nowarn', '-'], {
    cwd: workDir,
    env,
    input: snapshot.diff.uncommitted,
    timeoutMs: settings.limits.timeoutMs,
    maxOutputBytes: settings.limits.maxOutputBytes,
  });
  if (result.error || result.status !== 0) {
    isolationError(
      '固定した入力の未コミット差分を隔離コピーへ適用できませんでした。',
      '入力スナップショットを再解決してから再実行してください。対象コードをホスト実行しません。',
    );
  }
}

function removeGeneratedCredentials(workDir: string): void {
  for (const name of ['.npmrc', '.yarnrc', '.yarnrc.yml']) {
    rmSync(join(workDir, name), { force: true });
  }
}

function prepareDependencies(
  workDir: string,
  root: string,
  settings: ExecutionSettings,
  env: NodeJS.ProcessEnv,
): void {
  const mode = settings.dependencies.mode;
  const manifest = join(workDir, 'package.json');
  if (mode !== 'runner' && existsSync(manifest)) {
    removeGeneratedCredentials(workDir);
    const args = [
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--reporter=silent',
    ];
    if (mode === 'offline') args.push('--offline');
    if (mode === 'registry') {
      if (settings.dependencies.registry === null) {
        isolationError(
          'registry方式の依存準備にregistry設定がありません。',
          '利用者管理の許可profileへ許可するregistryを指定してください。',
        );
      }
      args.push('--registry', settings.dependencies.registry);
    }
    const result = runCommand('pnpm', args, {
      cwd: workDir,
      env,
      timeoutMs: settings.limits.timeoutMs,
      maxOutputBytes: settings.limits.maxOutputBytes,
    });
    if (result.timedOut) {
      isolationError(
        '隔離した依存準備がタイムアウトしました。',
        '依存準備の状態を確認し、resource上限を見直してから再実行してください。',
      );
    }
    if (result.error || result.status !== 0) {
      isolationError(
        '隔離した依存準備に失敗しました。',
        '利用者が許可したregistryまたはoffline storeを確認してください。対象コードをホスト実行しません。',
      );
    }
  }

  if (!existsSync(join(workDir, 'node_modules', 'vitest'))) {
    const runner = runnerInfo();
    mkdirSync(join(workDir, 'node_modules'), { recursive: true });
    symlinkSync(
      realRunnerPackageRoot(runner.runnerPath),
      join(workDir, 'node_modules', 'vitest'),
      'junction',
    );
  }
  void root;
}

function realRunnerPackageRoot(runnerPath: string): string {
  return dirname(runnerPath);
}

function createWorkspace(
  snapshot: VerificationInputSnapshot,
  settings: ExecutionSettings,
): IsolationWorkspace {
  assertIsolationSupported();
  const root = mkdtempSync(join(tmpdir(), 'latch-isolation-'));
  const workDir = join(root, 'repo');
  const tarPath = join(root, 'snapshot.tar');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  const env = sanitizedEnvironment(root);

  try {
    const archive = runCommand(
      'git',
      [
        'archive',
        '--format=tar',
        `--output=${tarPath}`,
        snapshot.repository.head,
      ],
      {
        cwd: snapshot.repository.root,
        env,
        timeoutMs: settings.limits.timeoutMs,
        maxOutputBytes: settings.limits.maxOutputBytes,
      },
    );
    if (archive.error || archive.status !== 0) {
      isolationError(
        '固定した入力のスナップショットを作成できませんでした。',
        'Gitの状態を確認してから再実行してください。対象コードをホスト実行しません。',
      );
    }
    if (!existsSync(tarPath)) {
      isolationError(
        '入力スナップショットのアーカイブが見つかりませんでした。',
        'Gitの状態を確認してから再実行してください。',
      );
    }
    if (lstatSync(tarPath).size > MAX_ARCHIVE_BYTES) {
      isolationError(
        '入力スナップショットが大きすぎるため隔離コピーを作成できません。',
        '検証対象を小さくするか、resource上限を見直してください。',
      );
    }
    const extract = runCommand('tar', ['-x', '-f', tarPath, '-C', workDir], {
      cwd: root,
      env,
      timeoutMs: settings.limits.timeoutMs,
      maxOutputBytes: settings.limits.maxOutputBytes,
    });
    if (extract.error || extract.status !== 0) {
      isolationError(
        '入力スナップショットを隔離コピーへ展開できませんでした。',
        'tarが利用できる環境で再実行してください。対象コードをホスト実行しません。',
      );
    }
    rmSync(tarPath, { force: true });
    rmSync(join(workDir, '.git'), { recursive: true, force: true });
    rmSync(join(workDir, 'node_modules'), { recursive: true, force: true });

    applyUncommitted(workDir, snapshot, env, settings);
    for (const file of snapshot.diff.untracked) {
      writeSafeFile(workDir, file.path, file.content);
    }
    const pruned = pruneEvaluationArtifacts(workDir);
    mkdirSync(join(workDir, '.latch', 'generated'), { recursive: true });

    prepareDependencies(workDir, root, settings, env);
    const runner = runnerInfo();
    const copiedFiles = countFiles(workDir);

    return {
      root,
      workDir,
      runnerPath: existsSync(
        join(workDir, 'node_modules', 'vitest', 'vitest.mjs'),
      )
        ? join(workDir, 'node_modules', 'vitest', 'vitest.mjs')
        : runner.runnerPath,
      runnerNodeModules: runner.nodeModules,
      copiedFiles,
      excluded: pruned.excluded.sort(),
      dependencyMode: settings.dependencies.mode,
      cleanup() {
        try {
          rmSync(root, { recursive: true, force: true });
          return {
            status: existsSync(root) ? 'failed' : 'removed',
            note: existsSync(root)
              ? '一時領域を削除できませんでした。'
              : '一時領域を削除しました。',
          };
        } catch (error) {
          return {
            status: 'failed',
            note: `一時領域の削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function createIsolatedWorkspace(
  snapshot: VerificationInputSnapshot,
  settings: ExecutionSettings,
): IsolationWorkspace {
  return createWorkspace(snapshot, settings);
}

export function writeGeneratedTest(
  workspace: IsolationWorkspace,
  file: string,
  content: string,
): void {
  writeSafeFile(workspace.workDir, file, content);
}

export function permissionFlags(workspace: IsolationWorkspace): string[] {
  const nodeRoot = resolve(dirname(process.execPath), '..');
  return [
    '--permission',
    `--allow-fs-read=${workspace.root}`,
    `--allow-fs-read=${workspace.runnerNodeModules}`,
    `--allow-fs-read=${nodeRoot}`,
    `--allow-fs-write=${workspace.root}`,
    '--allow-addons',
    '--allow-worker',
    '--no-warnings',
  ];
}
