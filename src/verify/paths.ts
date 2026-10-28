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

// Known credential locations are never model input or target-test files. This is
// path filtering, not secret detection; callers must keep secrets out of source.
export function isCredentialPath(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/');
  const base = parts.at(-1)?.toLowerCase() ?? '';
  return (
    parts.some((part) =>
      ['.claude', '.codex', '.ssh', '.aws', '.azure', '.config'].includes(
        part.toLowerCase(),
      ),
    ) ||
    base.startsWith('.env') ||
    [
      '.npmrc',
      '.netrc',
      '.git-credentials',
      'auth.json',
      'credentials.json',
      '.credentials.json',
      'id_rsa',
      'id_ed25519',
    ].includes(base) ||
    /\.(?:pem|key|p12|pfx)$/u.test(base)
  );
}
