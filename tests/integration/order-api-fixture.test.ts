import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

const fixtureRoot = fileURLToPath(
  new URL('../../fixtures/order-api', import.meta.url),
);
const script = join(fixtureRoot, 'scripts', 'prepare-candidate.ts');

interface Case {
  id: string;
  category: 'normal' | 'abnormal' | 'boundary';
  coveredBy: 'existing' | 'none';
  expected: { status: number };
}

const oracle = JSON.parse(
  readFileSync(join(fixtureRoot, 'evaluation', 'cases.json'), 'utf8'),
) as {
  request: { method: string; path: string };
  cases: Case[];
  issues: unknown[];
};

const temporary: string[] = [];

function prepare(change: string): {
  root: string;
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'latch-fixture-test-'));
  temporary.push(directory);
  const rootFile = join(directory, 'root.txt');
  const result = spawnSync(
    process.execPath,
    [script, change, rootFile, '--keep'],
    {
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  expect(result.error).toBeUndefined();
  if (existsSync(rootFile))
    temporary.push(readFileSync(rootFile, 'utf8').trim());
  return {
    root: existsSync(rootFile) ? readFileSync(rootFile, 'utf8').trim() : '',
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

afterAll(() => {
  for (const path of temporary.reverse())
    rmSync(path, { recursive: true, force: true });
});

describe('order API evaluation fixture', () => {
  test('oracle separates normal, abnormal and boundary cases', () => {
    expect(oracle.request).toEqual({ method: 'POST', path: '/orders/total' });
    const categories = new Set(oracle.cases.map((item) => item.category));
    expect(categories).toEqual(new Set(['normal', 'abnormal', 'boundary']));
    for (const item of oracle.cases) {
      expect(typeof item.expected.status).toBe('number');
    }
    const uncovered = oracle.cases.filter((item) => item.coveredBy === 'none');
    expect(uncovered.length).toBeGreaterThan(0);
    expect(uncovered.length).toBe(3);
    expect(oracle.issues.length).toBeGreaterThanOrEqual(1);
  });

  test('candidate copy excludes evaluation data and change patches', () => {
    const prepared = prepare('buggy');
    expect(prepared.status).toBe(1);
    expect(prepared.stdout).toContain('existing tests: passed');
    expect(prepared.stdout).toContain('evaluation tests: failed');
    expect(prepared.root.length).toBeGreaterThan(0);
    expect(existsSync(join(prepared.root, 'evaluation'))).toBe(false);
    expect(readdirSync(prepared.root)).not.toContain('evaluation');
    expect(readFileSync(join(prepared.root, 'REPRO.md'), 'utf8')).toContain(
      'evaluation/',
    );
    expect(existsSync(join(prepared.root, 'changes'))).toBe(false);
  });

  test('correct change passes existing and evaluation tests', () => {
    const prepared = prepare('correct');
    expect(prepared.status).toBe(0);
    expect(prepared.stdout).toMatch(/existing tests: passed/u);
    expect(prepared.stdout).toMatch(/evaluation tests: passed/u);
    const patched = readFileSync(join(prepared.root, 'src', 'api.ts'), 'utf8');
    expect(patched).not.toContain('node:http');
  });

  test('buggy change passes existing tests but is detected by evaluation tests', () => {
    const prepared = prepare('buggy');
    expect(prepared.status).toBe(1);
    expect(prepared.stdout).toMatch(/existing tests: passed/u);
    expect(prepared.stdout).toMatch(/evaluation tests: failed/u);
  });

  test('unknown change is rejected without a candidate', () => {
    const prepared = prepare('missing');
    expect(prepared.status).toBe(1);
    expect(prepared.stderr).toContain('unknown change');
    expect(prepared.root).toBe('');
  });

  test('issue file is valid structured markdown', () => {
    const issue = readFileSync(join(fixtureRoot, 'issue.md'), 'utf8');
    expect(issue.startsWith('# ')).toBe(true);
    expect(issue).toContain('## 受け入れ条件');
    expect(issue).toMatch(/`MAX_UNITS_PER_LINE`/u);
  });

  test('lockfile pins vitest and applies to the fixture manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(fixtureRoot, 'package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    const lockfile = readFileSync(join(fixtureRoot, 'pnpm-lock.yaml'), 'utf8');
    expect(manifest.devDependencies.vitest).toBe('5.0.5');
    expect(lockfile).toContain('specifier: 5.0.5');
    expect(lockfile).toContain("lockfileVersion: '9.0'");
  });

  test('invalid patch path cannot escape the changes directory', () => {
    const marker = mkdtempSync(join(tmpdir(), 'latch-fixture-path-'));
    temporary.push(marker);
    writeFileSync(join(marker, 'outside.patch'), '');
    const prepared = prepare('../' + marker);
    expect(prepared.status).toBe(1);
    expect(prepared.stderr).toContain('unknown change');
  });
});
