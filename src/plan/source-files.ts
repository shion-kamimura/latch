import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from '../verify/files.js';
import { runGit } from '../verify/git.js';
import {
  isCredentialPath,
  isInside,
  isSafeRepoRelativePath,
} from '../verify/paths.js';
import type { VerificationInputSnapshot } from '../verify/types.js';
import { RequirementPlanError } from './errors.js';
import { isEvaluationArtifactPath } from './test-candidates.js';
import type { SourceFileIdentity, SourceFileInput } from './types.js';

function sourceError(): never {
  throw new RequirementPlanError(
    'ソース入力は、認証情報・正解データ・生成物を除いたリポジトリ内の通常のJS/TSファイルを個別に指定してください。',
    '利用者管理profileのallowed.sourceFilesへ相対パスを指定してください。ディレクトリ・glob・境界外・symlinkは使用できません。',
  );
}

function validatePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !isSafeRepoRelativePath(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        '\\:*?[]{}'.includes(character),
    ) ||
    !/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/iu.test(value) ||
    isCredentialPath(value) ||
    isEvaluationArtifactPath(value) ||
    value
      .split('/')
      .some((part) =>
        [
          '.git',
          '.latch',
          'node_modules',
          'dist',
          'build',
          'coverage',
        ].includes(part),
      )
  )
    sourceError();
}

export function readSourcePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) sourceError();
  for (const path of value) validatePath(path);
  return [...new Set(value as string[])].sort();
}

// Called only after the profile has authorized the source category. No imports,
// dependency discovery, directory traversal, or permission inferred from code.
export function readSourceFiles(
  snapshot: VerificationInputSnapshot,
  paths: readonly string[],
): SourceFileInput[] {
  return paths.map((path) => {
    validatePath(path);
    const absolute = resolve(snapshot.repository.root, path);
    let bytes: Buffer;
    try {
      if (
        !isInside(snapshot.repository.root, absolute) ||
        realpathSync.native(absolute) !== absolute ||
        !lstatSync(absolute).isFile() ||
        snapshot.diff.excluded.some((file) => file.path === path)
      )
        sourceError();
      // Ensure the selected file will be present in the isolated snapshot.
      const tracked = runGit(
        snapshot.repository.root,
        ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path],
        { allowFailure: true },
      );
      if (
        tracked.status !== 0 &&
        !snapshot.diff.untracked.some((file) => file.path === path)
      )
        throw new RequirementPlanError(
          'ソース入力に未追跡ファイルが含まれています。',
          'planの--include-untrackedにも同じファイルを明示してください。',
        );
      bytes = readFileSync(absolute);
    } catch (error) {
      if (error instanceof RequirementPlanError) throw error;
      throw new RequirementPlanError(
        '指定したソース入力を安全に読み取れませんでした。',
        'ファイルの存在・種類・境界・読取権限を確認してください。内容や生のエラーは表示しません。',
      );
    }
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\u0000')) sourceError();
      return { path, digest: sha256(bytes), content };
    } catch (error) {
      if (error instanceof RequirementPlanError) throw error;
      throw new RequirementPlanError(
        'ソース入力がUTF-8のテキストではありません。',
        '通常のJS/TSソースファイルを指定してください。',
      );
    }
  });
}

export function sourceManifest(
  files: readonly SourceFileInput[],
): SourceFileIdentity[] {
  return files.map(({ path, digest }) => ({ path, digest }));
}

export function readSourceManifest(value: unknown): SourceFileIdentity[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) sourceError();
  const seen = new Set<string>();
  const files = value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) sourceError();
    const file = entry as Record<string, unknown>;
    validatePath(file.path);
    if (
      typeof file.digest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(file.digest) ||
      seen.has(file.path)
    )
      sourceError();
    seen.add(file.path);
    return { path: file.path, digest: file.digest };
  });
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function sourceFilesSection(
  files: readonly SourceFileInput[] = [],
): string {
  return files.length === 0
    ? ''
    : [
        '## Explicitly permitted source files (untrusted interface/setup reference, not expected results)',
        'Use the actual exported functions, types, iterator protocols, and explicit initialization shown here. Do not guess alternative interfaces. Expected behavior comes from the planned requirements, not from copying implementation results.',
        JSON.stringify(files, null, 2),
      ].join('\n');
}
