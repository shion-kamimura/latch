import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

export function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== '..' &&
      !isAbsolute(relativePath))
  );
}

export function relativeToRoot(root: string, candidate: string): string {
  return toPosixPath(relative(root, candidate));
}

export function realPathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

export function resolveFrom(cwd: string, path: string): string {
  return resolve(cwd, path);
}

export function isSafeRepoRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || isAbsolute(path)) {
    return false;
  }
  const segments = path.split('/');
  return segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..',
  );
}

export function isGitInternalPath(path: string): boolean {
  return path === '.git' || path.startsWith('.git/');
}
