import { spawnSync } from 'node:child_process';
import { realPathOrNull } from './paths.js';
import { VerificationInputError } from './errors.js';

export interface GitResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly error?: Error;
}

const gitEnvironment = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

export function runGit(
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean } = {},
): GitResult {
  // diff may refresh stat information in the index even for a read-only input
  // resolution. In particular, restored files can have new mtimes but identical
  // contents. Disable that refresh as well as optional locking.
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.quotepath=false',
      '-c',
      'diff.autoRefreshIndex=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'buffer',
      env: gitEnvironment,
      maxBuffer: Infinity,
      windowsHide: true,
    },
  );
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.alloc(0);
  const stderrBuffer = Buffer.isBuffer(result.stderr)
    ? result.stderr
    : Buffer.alloc(0);
  const stderr = stderrBuffer.toString('utf8').trim();

  if (result.error) {
    if (options.allowFailure) {
      return { status: null, stdout, stderr, error: result.error };
    }
    throw new VerificationInputError(
      'Gitを実行できませんでした。Gitがインストールされているか確認してください。',
      'git --version を実行して利用可能な状態にしてから再実行してください。',
      2,
    );
  }

  if (result.status !== 0 && !options.allowFailure) {
    throw new VerificationInputError(
      'Gitの読み取りに失敗しました。',
      'リポジトリの状態を確認し、必要に応じて再度実行してください。',
      2,
    );
  }

  return { status: result.status, stdout, stderr };
}

export function resolveRepositoryRoot(cwd: string): string {
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree'], {
    allowFailure: true,
  });
  if (inside.status !== 0 || inside.stdout.toString('utf8').trim() !== 'true') {
    throw new VerificationInputError(
      'Git管理されたリポジトリのワークツリー内で実行してください。',
      '対象リポジトリへ移動するか、Gitリポジトリを初期化してから再実行してください。',
    );
  }

  const result = runGit(cwd, ['rev-parse', '--show-toplevel']);
  const topLevel = result.stdout.toString('utf8').trim();
  if (!topLevel) {
    throw new VerificationInputError(
      'リポジトリのルートを特定できませんでした。',
      'Git管理されたリポジトリのワークツリー内で再実行してください。',
    );
  }

  return realPathOrNull(topLevel) ?? topLevel;
}

function verifyCommitRef(root: string, ref: string): string | null {
  const result = runGit(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    { allowFailure: true },
  );
  if (result.status !== 0) return null;
  const commit = result.stdout.toString('utf8').trim();
  return commit.length > 0 ? commit : null;
}

export interface BaseCommit {
  readonly ref: string;
  readonly commit: string;
  readonly requested: string | null;
  readonly usedDefault: boolean;
}

function defaultBaseCandidates(root: string): string[] {
  const candidates: string[] = [];
  const symbolic = runGit(
    root,
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    { allowFailure: true },
  );
  if (symbolic.status === 0) {
    const ref = symbolic.stdout.toString('utf8').trim();
    if (ref) candidates.push(ref);
  }
  candidates.push('refs/remotes/origin/main', 'refs/heads/main');
  return [...new Set(candidates)];
}

function displayRef(ref: string): string {
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  return ref;
}

export function resolveBaseCommit(
  root: string,
  requested: string | undefined,
): BaseCommit {
  if (requested !== undefined) {
    if (requested.trim().length === 0) {
      throw new VerificationInputError(
        '比較対象のrefが空です。',
        '--base <ref> にブランチ名・タグ・コミットを指定してください。',
      );
    }
    const commit = verifyCommitRef(root, requested);
    if (!commit) {
      throw new VerificationInputError(
        '指定された比較対象refを解決できませんでした。',
        '--base <ref> に存在するブランチ名・タグ・コミットを指定してください。',
      );
    }
    return {
      ref: requested,
      commit,
      requested,
      usedDefault: false,
    };
  }

  for (const candidate of defaultBaseCandidates(root)) {
    const commit = verifyCommitRef(root, candidate);
    if (commit) {
      return {
        ref: displayRef(candidate),
        commit,
        requested: null,
        usedDefault: true,
      };
    }
  }

  throw new VerificationInputError(
    '既定の比較対象を解決できませんでした。',
    '--base <ref> で比較対象を明示してください（例: --base origin/main）。',
  );
}

export function resolveHeadCommit(root: string): string {
  const commit = verifyCommitRef(root, 'HEAD');
  if (!commit) {
    throw new VerificationInputError(
      'HEADのコミットを解決できませんでした。',
      '少なくとも1件コミットしたうえで再実行してください。',
    );
  }
  return commit;
}

export function resolveMergeBase(
  root: string,
  baseCommit: string,
  headCommit: string,
): string {
  const result = runGit(
    root,
    ['merge-base', '--end-of-options', baseCommit, headCommit],
    { allowFailure: true },
  );
  const mergeBase = result.stdout.toString('utf8').trim();
  if (result.status !== 0 || !mergeBase) {
    throw new VerificationInputError(
      '比較対象とHEADに共通の祖先がありません。',
      '--base <ref> に関連する履歴を持つrefを指定してください。',
    );
  }
  return mergeBase;
}

interface RawDiffEntry {
  readonly path: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly status: string;
}

function splitNull(buffer: Buffer): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      parts.push(buffer.subarray(start, index).toString('utf8'));
      start = index + 1;
    }
  }
  if (start < buffer.length)
    parts.push(buffer.subarray(start).toString('utf8'));
  return parts;
}

function parseRawDiff(buffer: Buffer): RawDiffEntry[] {
  const parts = splitNull(buffer);
  const entries: RawDiffEntry[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = parts[index];
    const path = parts[index + 1];
    if (!meta?.startsWith(':') || path === undefined) continue;
    const fields = meta.slice(1).split(' ');
    const oldMode = fields[0];
    const newMode = fields[1];
    const status = fields[4];
    if (!oldMode || !newMode || !status) continue;
    entries.push({ path, oldMode, newMode, status });
  }
  return entries;
}

function parseNumstat(
  buffer: Buffer,
): Map<string, { additions: number | null; deletions: number | null }> {
  const parts = splitNull(buffer);
  const map = new Map<
    string,
    { additions: number | null; deletions: number | null }
  >();
  for (const part of parts) {
    if (!part) continue;
    const firstTab = part.indexOf('\t');
    const secondTab = part.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsText = part.slice(0, firstTab);
    const deletionsText = part.slice(firstTab + 1, secondTab);
    const path = part.slice(secondTab + 1);
    if (!path) continue;
    map.set(path, {
      additions: additionsText === '-' ? null : Number(additionsText),
      deletions: deletionsText === '-' ? null : Number(deletionsText),
    });
  }
  return map;
}

export interface DiffCommandEntry {
  readonly path: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly status: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export function diffEntries(
  root: string,
  from: string,
  to: string | null,
): DiffCommandEntry[] {
  const range = to ? [from, to] : [from];
  const raw = runGit(root, [
    'diff',
    '--raw',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    ...range,
    '--',
  ]);
  const numstat = runGit(root, [
    'diff',
    '--numstat',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    ...range,
    '--',
  ]);
  const stats = parseNumstat(numstat.stdout);
  return parseRawDiff(raw.stdout).map((entry) => {
    const stat = stats.get(entry.path);
    return {
      ...entry,
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      binary:
        stat !== undefined &&
        stat.additions === null &&
        stat.deletions === null,
    };
  });
}

export function diffText(
  root: string,
  from: string,
  to: string | null,
  paths: readonly string[],
): string {
  if (paths.length === 0) return '';
  const range = to ? [from, to] : [from];
  const result = runGit(root, [
    'diff',
    '--no-color',
    '--no-renames',
    '--no-ext-diff',
    ...range,
    '--',
    ...paths,
  ]);
  return result.stdout.toString('utf8');
}

export function listUntracked(root: string): string[] {
  const result = runGit(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  return splitNull(result.stdout).filter((path) => path.length > 0);
}
