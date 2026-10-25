import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  createTestRepository,
  type TestRepository,
} from '../helpers/repository.js';

const repositories: TestRepository[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
});

test('compares fixed cases, rejects an always-successful baseline, and records no raw output', () => {
  const repository = createTestRepository();
  repositories.push(repository);
  repository.write(
    'package.json',
    JSON.stringify({
      type: 'module',
      packageManager: 'pnpm@12.14.0',
      devDependencies: {},
    }),
  );
  repository.write('.node-version', process.versions.node);
  repository.write(
    'scripts/evaluate-environment.ts',
    readFileSync(
      new URL('../../scripts/evaluate-environment.ts', import.meta.url),
      'utf8',
    ),
  );
  repository.write(
    'scripts/check-environment.ts',
    'console.log("準備項目を確認しました");\n',
  );
  const baseline = repository.commit('known incorrect always-ready diagnosis');
  repository.write(
    'scripts/check-environment.ts',
    readFileSync(
      new URL('../../scripts/check-environment.ts', import.meta.url),
      'utf8',
    ),
  );
  const output = join(repository.root, 'result.json');
  const result = spawnSync(
    process.execPath,
    [
      join(repository.root, 'scripts/evaluate-environment.ts'),
      '--baseline',
      baseline,
      '--trials',
      '1',
      '--output',
      output,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  expect(report.summary).toEqual([
    { version: 'baseline', passed: 1, total: 7, inconclusive: 0 },
    { version: 'current', passed: 7, total: 7, inconclusive: 0 },
  ]);
  expect(report.runs).toHaveLength(14);
  expect(report.baseline).toBe(baseline);
  expect(report.currentScript).toMatch(/^[a-f0-9]{40}$/);
  expect(report.model).toBeNull();
  expect(report.llmCost).toBeNull();
  expect(
    report.runs.every(
      (run: Record<string, unknown>) =>
        !('stdout' in run) && !('stderr' in run),
    ),
  ).toBe(true);
});
