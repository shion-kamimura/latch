import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VerificationInputError } from './errors.js';
import {
  isInside,
  isCredentialPath,
  realPathOrNull,
  relativeToRoot,
} from './paths.js';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface ReadIssueResult {
  readonly path: string;
  readonly title: string;
  readonly state: string;
  readonly source: string;
  readonly content: string;
  readonly digest: string;
}

interface FrontMatter {
  readonly body: string;
  readonly values: ReadonlyMap<string, string>;
}

function parseFrontMatter(content: string): FrontMatter {
  if (!content.startsWith('---\n')) {
    return { body: content, values: new Map() };
  }
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) {
    return { body: content, values: new Map() };
  }
  const header = content.slice(4, end);
  const values = new Map<string, string>();
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key && value) values.set(key, value);
  }
  return { body: content.slice(end + 5), values };
}

function parseTitle(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^#\s+(.+)$/u.exec(trimmed);
    return match?.[1]?.trim() ?? null;
  }
  return null;
}

export function readIssueFile(
  root: string,
  cwd: string,
  inputPath: string,
): ReadIssueResult {
  if (inputPath.trim().length === 0) {
    throw new VerificationInputError(
      'Issueファイルのパスが空です。',
      '--issue-file <path> にリポジトリ内のMarkdownファイルを指定してください。',
    );
  }

  const absolutePath = resolve(cwd, inputPath);
  if (!isInside(root, absolutePath)) {
    throw new VerificationInputError(
      'Issueファイルがリポジトリ境界外を指しています。',
      '--issue-file <path> にリポジトリ内のMarkdownファイルを指定してください。',
    );
  }

  if (isCredentialPath(relativeToRoot(root, absolutePath))) {
    throw new VerificationInputError(
      '認証情報のパスはIssue入力に使用できません。',
      '認証情報を含まないMarkdownファイルを指定してください。',
    );
  }

  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch {
    throw new VerificationInputError(
      'Issueファイルが見つかりませんでした。',
      '--issue-file <path> に存在するMarkdownファイルを指定してください。',
    );
  }

  if (stats.isSymbolicLink()) {
    throw new VerificationInputError(
      'Issueファイルにシンボリックリンクは使用できません。',
      'リポジトリ内の通常ファイルを --issue-file <path> に指定してください。',
    );
  }
  if (!stats.isFile()) {
    throw new VerificationInputError(
      'Issueファイルが通常ファイルではありません。',
      'リポジトリ内の通常のMarkdownファイルを --issue-file <path> に指定してください。',
    );
  }

  const realPath = realPathOrNull(absolutePath);
  if (!realPath || !isInside(root, realPath)) {
    throw new VerificationInputError(
      'Issueファイルがリポジトリ境界外を指しています。',
      'リポジトリ内の通常ファイルを --issue-file <path> に指定してください。',
    );
  }

  if (isCredentialPath(relativeToRoot(root, realPath))) {
    throw new VerificationInputError(
      '認証情報のパスはIssue入力に使用できません。',
      '認証情報を含まないMarkdownファイルを指定してください。',
    );
  }

  const buffer = readFileSync(realPath);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new VerificationInputError(
      'IssueファイルをUTF-8として読み取れませんでした。',
      '--issue-file <path> にUTF-8で保存したMarkdownファイルを指定してください。',
    );
  }

  if (content.includes('\u0000')) {
    throw new VerificationInputError(
      'Issueファイルがテキスト形式ではありません。',
      '--issue-file <path> にUTF-8のMarkdownファイルを指定してください。',
    );
  }

  if (content.trim().length === 0) {
    throw new VerificationInputError(
      'Issueファイルが空です。',
      '要件を記述したMarkdownファイルを --issue-file <path> に指定してください。',
    );
  }

  const normalizedContent = content.startsWith('\uFEFF')
    ? content.slice(1)
    : content;
  const frontMatter = parseFrontMatter(normalizedContent);
  const title = parseTitle(frontMatter.body);
  if (!title) {
    throw new VerificationInputError(
      'Issueファイルの形式が不正です。Markdownのタイトル（# 見出し）が必要です。',
      '先頭に「# タイトル」を記述したMarkdownファイルを --issue-file <path> に指定してください。',
    );
  }

  return {
    path: relativeToRoot(root, realPath),
    title,
    state:
      frontMatter.values.get('state') ??
      frontMatter.values.get('status') ??
      'unknown',
    source:
      frontMatter.values.get('source') ??
      frontMatter.values.get('url') ??
      relativeToRoot(root, realPath),
    content,
    digest: sha256(buffer),
  };
}

export interface UntrackedReadResult {
  readonly content: string | null;
  readonly reason:
    'binary' | 'not-utf8' | 'symlink' | 'outside-boundary' | null;
}

export function readUntrackedFile(
  root: string,
  absolutePath: string,
): UntrackedReadResult {
  if (!isInside(root, absolutePath)) {
    return { content: null, reason: 'outside-boundary' };
  }
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch {
    return { content: null, reason: null };
  }
  if (stats.isSymbolicLink()) return { content: null, reason: 'symlink' };
  if (!stats.isFile()) return { content: null, reason: null };

  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) return { content: null, reason: 'binary' };
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { content, reason: null };
  } catch {
    return { content: null, reason: 'not-utf8' };
  }
}
