import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256 } from '../verify/files.js';
import { isCredentialPath, toPosixPath } from '../verify/paths.js';
import type { ExistingTestCandidate } from './types.js';

const MAX_EXCERPT_CHARACTERS = 1_200;
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.pnpm-store',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'evaluation',
]);

const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const TEST_CALL =
  /\b(?:test|it)(?:\.(?:each|skip|only|concurrent|todo|fails|runIf))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gu;

export interface DiscoveredTestCandidate extends ExistingTestCandidate {
  readonly excerpt: string;
}

export interface TestDiscoveryResult {
  readonly candidates: readonly DiscoveredTestCandidate[];
  readonly warnings: readonly string[];
  readonly scannedFiles: number;
  readonly excluded: readonly string[];
}

export function isEvaluationArtifactPath(path: string): boolean {
  const segments = path.split('/');
  if (segments.includes('evaluation')) return true;
  const base = segments.at(-1) ?? '';
  if (segments.includes('changes') && /\.(?:patch|diff)$/iu.test(base)) {
    return true;
  }
  return base === 'cases.json' || base === 'expected.json';
}

function decodeUtf8(path: string): string | null {
  try {
    const buffer = readFileSync(path);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function excerptAround(content: string, index: number): string {
  const start = Math.max(0, content.lastIndexOf('\n', index) + 1);
  const next = content.indexOf('\n', index);
  const lineEnd = next < 0 ? content.length : next;
  const from = content.lastIndexOf('\n', start - 1);
  const blockStart = from < 0 ? 0 : from + 1;
  const end = Math.min(
    content.length,
    Math.max(lineEnd + 1, blockStart + MAX_EXCERPT_CHARACTERS),
  );
  return content.slice(
    blockStart,
    Math.min(end, blockStart + MAX_EXCERPT_CHARACTERS),
  );
}

function testNames(content: string): { name: string; index: number }[] {
  const names: { name: string; index: number }[] = [];
  for (const match of content.matchAll(TEST_CALL)) {
    const name = match[2]?.trim();
    if (!name) continue;
    names.push({ name, index: match.index ?? 0 });
  }
  return names;
}

function candidateId(path: string, name: string, index: number): string {
  return `test-${sha256(`${path}\u0000${name}\u0000${index}`).slice(0, 10)}`;
}

function walk(
  root: string,
  directory: string,
  files: string[],
  excluded: string[],
  warnings: string[],
): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    warnings.push(
      `テスト候補の探索でディレクトリを読み取れませんでした: ${toPosixPath(relative(root, directory)) || '.'}`,
    );
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const relativePath = toPosixPath(relative(root, absolute));
    if (entry.isSymbolicLink() || isCredentialPath(relativePath)) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        if (entry.name === 'evaluation' && relativePath.length > 0) {
          excluded.push(relativePath);
        }
        continue;
      }
      walk(root, absolute, files, excluded, warnings);
      continue;
    }
    if (!entry.isFile() || !TEST_FILE.test(entry.name)) continue;
    if (isEvaluationArtifactPath(relativePath)) {
      excluded.push(relativePath);
      continue;
    }
    files.push(relativePath);
  }
}

export function discoverVitestCandidates(root: string): TestDiscoveryResult {
  const files: string[] = [];
  const excluded: string[] = [];
  const warnings: string[] = [];
  walk(root, root, files, excluded, warnings);

  const candidates: DiscoveredTestCandidate[] = [];
  for (const path of files) {
    const absolute = join(root, ...path.split('/'));
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    const content = decodeUtf8(absolute);
    if (content === null) {
      warnings.push(`テスト候補をUTF-8として読めませんでした: ${path}`);
      continue;
    }
    const names = testNames(content);
    if (names.length === 0) {
      candidates.push({
        id: candidateId(path, path, 0),
        path,
        name: path,
        framework: 'vitest',
        matchedConditionIds: [],
        excerpt: content.slice(0, MAX_EXCERPT_CHARACTERS),
      });
      continue;
    }
    names.forEach((entry, index) => {
      candidates.push({
        id: candidateId(path, entry.name, index),
        path,
        name: entry.name,
        framework: 'vitest',
        matchedConditionIds: [],
        excerpt: excerptAround(content, entry.index),
      });
    });
  }

  return {
    candidates,
    warnings,
    scannedFiles: files.length,
    excluded: [...new Set(excluded)].sort(),
  };
}
