import { lstatSync } from 'node:fs';
import { VerificationInputError } from './errors.js';
import {
  diffEntries,
  diffText,
  listUntracked,
  resolveBaseCommit,
  resolveHeadCommit,
  resolveMergeBase,
  resolveRepositoryRoot,
  type DiffCommandEntry,
} from './git.js';
import { readIssueFile, readUntrackedFile, sha256 } from './files.js';
import {
  isGitInternalPath,
  isCredentialPath,
  isInside,
  relativeToRoot,
  resolveFrom,
} from './paths.js';
import type {
  ChangedFile,
  ExcludedFile,
  ExclusionReason,
  Reproducibility,
  UntrackedFile,
  VerificationInputSnapshot,
  VerifyOptions,
} from './types.js';

const MAX_WARNING_PATHS = 20;

function statusLabel(status: string): string {
  return status.slice(0, 1).toUpperCase();
}

function exclusionReason(entry: DiffCommandEntry): ExclusionReason | null {
  if (isCredentialPath(entry.path)) return 'credential';
  if (!entry.path || isGitInternalPath(entry.path)) return 'git-internal';
  if (entry.oldMode === '120000' || entry.newMode === '120000') {
    return 'symlink';
  }
  if (entry.oldMode === '160000' || entry.newMode === '160000') {
    return 'submodule';
  }
  if (entry.binary) return 'binary';
  return null;
}

function classify(
  entries: readonly DiffCommandEntry[],
  kind: 'committed' | 'uncommitted',
): { files: ChangedFile[]; excluded: ExcludedFile[] } {
  const files: ChangedFile[] = [];
  const excluded: ExcludedFile[] = [];
  for (const entry of entries) {
    const reason = exclusionReason(entry);
    if (reason) {
      excluded.push({ path: entry.path, kind, reason });
      continue;
    }
    files.push({
      path: entry.path,
      kind,
      status: statusLabel(entry.status),
      additions: entry.additions,
      deletions: entry.deletions,
    });
  }
  return { files, excluded };
}

function sanitizeDisplayPath(path: string): string {
  let sanitized = '';
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    sanitized += code < 32 || code === 127 ? '?' : character;
  }
  return sanitized.slice(0, 200);
}

function untrackedWarning(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const warnings = [
    `未追跡ファイル ${paths.length} 件を既定で除外しました。取り込むには --include-untracked <path> を指定してください。`,
  ];
  for (const path of paths.slice(0, MAX_WARNING_PATHS)) {
    warnings.push(`未追跡（除外）: ${sanitizeDisplayPath(path)}`);
  }
  if (paths.length > MAX_WARNING_PATHS) {
    warnings.push(
      `未追跡（除外）: ほか ${paths.length - MAX_WARNING_PATHS} 件`,
    );
  }
  return warnings;
}

function resolveUntracked(
  root: string,
  cwd: string,
  requestedPaths: readonly string[],
  untracked: readonly string[],
): {
  included: UntrackedFile[];
  excluded: ExcludedFile[];
  warnings: string[];
} {
  const included: UntrackedFile[] = [];
  const excluded: ExcludedFile[] = [];
  const seen = new Set<string>();
  const untrackedSet = new Set(untracked);

  for (const requested of requestedPaths) {
    if (requested.trim().length === 0) {
      throw new VerificationInputError(
        '未追跡ファイルの指定が空です。',
        '--include-untracked <path> にリポジトリ内のファイルを指定してください。',
      );
    }

    const absolutePath = resolveFrom(cwd, requested);
    if (!isInside(root, absolutePath)) {
      excluded.push({
        path: requested,
        kind: 'untracked',
        reason: 'outside-boundary',
      });
      continue;
    }

    const relativePath = relativeToRoot(root, absolutePath);
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);

    if (isCredentialPath(relativePath)) {
      excluded.push({
        path: relativePath,
        kind: 'untracked',
        reason: 'credential',
      });
      continue;
    }
    if (isGitInternalPath(relativePath)) {
      excluded.push({
        path: relativePath,
        kind: 'untracked',
        reason: 'git-internal',
      });
      continue;
    }

    let stats;
    try {
      stats = lstatSync(absolutePath);
    } catch {
      throw new VerificationInputError(
        `指定された未追跡ファイルが見つかりませんでした: ${sanitizeDisplayPath(relativePath)}`,
        '--include-untracked <path> に存在する未追跡ファイルを指定してください。',
      );
    }

    if (stats.isSymbolicLink()) {
      excluded.push({
        path: relativePath,
        kind: 'untracked',
        reason: 'symlink',
      });
      continue;
    }

    if (!stats.isFile()) {
      throw new VerificationInputError(
        `指定された未追跡パスが通常ファイルではありません: ${sanitizeDisplayPath(relativePath)}`,
        '--include-untracked <path> にファイルパスを指定してください。',
      );
    }

    if (!untrackedSet.has(relativePath)) {
      throw new VerificationInputError(
        `指定されたパスは未追跡の通常ソースではありません: ${sanitizeDisplayPath(relativePath)}`,
        'git status --porcelain で未追跡と表示されるファイルを --include-untracked <path> に指定してください。',
      );
    }

    const read = readUntrackedFile(root, absolutePath);
    if (read.reason) {
      excluded.push({
        path: relativePath,
        kind: 'untracked',
        reason: read.reason,
      });
      continue;
    }
    if (read.content === null) {
      throw new VerificationInputError(
        `未追跡ファイルを読み取れませんでした: ${sanitizeDisplayPath(relativePath)}`,
        'ファイルの権限と種類を確認してから再実行してください。',
      );
    }

    included.push({
      path: relativePath,
      content: read.content,
      digest: sha256(read.content),
    });
  }

  const excludedPaths = new Set(excluded.map((entry) => entry.path));
  const remaining = untracked.filter(
    (path) =>
      !seen.has(path) &&
      !excludedPaths.has(path) &&
      !included.some((entry) => entry.path === path),
  );
  return { included, excluded, warnings: untrackedWarning(remaining) };
}

function computeDiffDigest(
  committed: string,
  uncommitted: string,
  untracked: readonly UntrackedFile[],
): string {
  return sha256(
    [
      'latch-diff-v1',
      `committed:${sha256(committed)}`,
      `uncommitted:${sha256(uncommitted)}`,
      ...untracked
        .slice()
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((file) => `untracked:${file.path}:${file.digest}`),
    ].join('\n'),
  );
}

function computeSnapshotDigest(
  head: string,
  baseCommit: string,
  mergeBase: string,
  diffDigest: string,
  issueDigest: string,
): string {
  return sha256(
    [
      'latch-input-snapshot-v1',
      `head:${head}`,
      `base:${baseCommit}`,
      `merge-base:${mergeBase}`,
      `diff:${diffDigest}`,
      `issue:${issueDigest}`,
    ].join('\n'),
  );
}

function reproducibilityFor(
  hasUncommitted: boolean,
  untrackedIncluded: boolean,
): Reproducibility {
  const notes: string[] = [];
  if (hasUncommitted) {
    notes.push(
      '未コミットの変更を含むため、同じbase・Issue指定でもCIでは再現できません。',
    );
  }
  if (untrackedIncluded) {
    notes.push(
      '明示指定した未追跡ファイルを含むため、コミットするまでCIでは再現できません。',
    );
  }
  return { ciReproducible: notes.length === 0, notes };
}

function rerunCommand(options: VerifyOptions, resolvedBaseRef: string): string {
  const parts = ['latch', 'verify'];
  parts.push('--base', options.base ?? resolvedBaseRef);
  if (options.issueFile !== undefined) {
    parts.push('--issue-file', options.issueFile);
  }
  for (const path of options.includeUntracked) {
    parts.push('--include-untracked', path);
  }
  if (options.json) parts.push('--json');
  return parts.join(' ');
}

export function resolveVerificationInputs(
  options: VerifyOptions,
  cwd: string,
): VerificationInputSnapshot {
  const root = resolveRepositoryRoot(cwd);
  const baseCommit = resolveBaseCommit(root, options.base);
  const head = resolveHeadCommit(root);
  const mergeBase = resolveMergeBase(root, baseCommit.commit, head);
  const issue =
    options.issueFile === undefined
      ? null
      : readIssueFile(root, cwd, options.issueFile);

  const committedEntries = diffEntries(root, mergeBase, head);
  const uncommittedEntries = diffEntries(root, head, null);
  const committed = classify(committedEntries, 'committed');
  const uncommitted = classify(uncommittedEntries, 'uncommitted');
  const committedText = diffText(
    root,
    mergeBase,
    head,
    committed.files.map((file) => file.path),
  );
  const uncommittedText = diffText(
    root,
    head,
    null,
    uncommitted.files.map((file) => file.path),
  );

  const untracked = resolveUntracked(
    root,
    cwd,
    options.includeUntracked,
    listUntracked(root),
  );

  const excluded = [
    ...committed.excluded,
    ...uncommitted.excluded,
    ...untracked.excluded,
  ];
  const files = [...committed.files, ...uncommitted.files];
  if (files.length === 0 && untracked.included.length === 0) {
    const guidanceParts = [
      'コミット済み・未コミットの変更を用意するか、--base <ref> を確認してください。',
    ];
    if (untracked.warnings.length > 0) {
      guidanceParts.push(
        '未追跡ファイルを取り込む場合は --include-untracked <path> を指定してください。',
      );
    }
    const exclusionDetails =
      excluded.length > 0
        ? ` 除外: ${excluded
            .map((file) => `${sanitizeDisplayPath(file.path)} (${file.reason})`)
            .join(', ')}`
        : '';
    throw new VerificationInputError(
      `検証対象の差分が空です。${exclusionDetails}`,
      guidanceParts.join(' '),
    );
  }

  const diffDigest = computeDiffDigest(
    committedText,
    uncommittedText,
    untracked.included,
  );
  const snapshotDigest = computeSnapshotDigest(
    head,
    baseCommit.commit,
    mergeBase,
    diffDigest,
    issue?.digest ?? 'none',
  );

  return {
    phase: 'input-resolution',
    verification: 'not-run',
    repository: { root, head },
    base: {
      requested: baseCommit.requested,
      ref: baseCommit.ref,
      commit: baseCommit.commit,
      mergeBase,
      usedDefault: baseCommit.usedDefault,
    },
    diff: {
      committed: committedText,
      uncommitted: uncommittedText,
      untracked: untracked.included,
      files,
      excluded,
      digest: diffDigest,
    },
    issue,
    warnings: [
      ...(issue === null
        ? ['Issueが指定されていないため、要件は差分からしか推定できません。']
        : []),
      ...untracked.warnings,
    ],
    reproducibility: reproducibilityFor(
      uncommitted.files.length > 0,
      untracked.included.length > 0,
    ),
    digest: snapshotDigest,
    rerunCommand: rerunCommand(options, baseCommit.ref),
  };
}
