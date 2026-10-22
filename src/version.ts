import { readFileSync } from 'node:fs';

export function getVersion(): string {
  const packageJson = readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8',
  );
  const parsed: unknown = JSON.parse(packageJson);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error('Unable to read version from package.json');
  }
  return parsed.version;
}
