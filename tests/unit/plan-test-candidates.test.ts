import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  discoverVitestCandidates,
  isEvaluationArtifactPath,
} from '../../src/plan/test-candidates.js';
import { createTemporaryDirectory } from '../helpers/plan.js';

const directories: { cleanup(): void }[] = [];

function temporary() {
  const directory = createTemporaryDirectory();
  directories.push(directory);
  return directory;
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

afterEach(() => {
  for (const directory of directories.splice(0)) directory.cleanup();
});

describe('Vitest candidate discovery', () => {
  test('reads test names without executing test files', () => {
    const directory = temporary();
    const marker = join(directory.root, 'executed.marker');
    write(
      directory.root,
      'src/a.test.ts',
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(marker)}, 'executed');`,
        "test('adds values', () => {});",
        "it('handles an error', () => {});",
      ].join('\n'),
    );
    write(
      directory.root,
      'test/existing.test.ts',
      "test('keeps behavior', () => {});\n",
    );

    const first = discoverVitestCandidates(directory.root);
    const second = discoverVitestCandidates(directory.root);

    expect(existsSync(marker)).toBe(false);
    expect(first.candidates.map((candidate) => candidate.name)).toEqual([
      'adds values',
      'handles an error',
      'keeps behavior',
    ]);
    expect(
      first.candidates.every((candidate) => candidate.framework === 'vitest'),
    ).toBe(true);
    expect(second.candidates.map((candidate) => candidate.id)).toEqual(
      first.candidates.map((candidate) => candidate.id),
    );
  });

  test('excludes evaluation data before it can reach the LLM input', () => {
    const directory = temporary();
    write(
      directory.root,
      'fixtures/order-api/evaluation/evaluate.test.ts',
      "test('oracle case', () => {});\n",
    );
    write(
      directory.root,
      'fixtures/order-api/test/existing.test.ts',
      "test('existing behavior', () => {});\n",
    );
    write(
      directory.root,
      'node_modules/pkg/ignored.test.ts',
      "test('ignored', () => {});\n",
    );

    const result = discoverVitestCandidates(directory.root);

    expect(result.candidates.map((candidate) => candidate.path)).toEqual([
      'fixtures/order-api/test/existing.test.ts',
    ]);
    expect(result.excluded).toContain('fixtures/order-api/evaluation');
    expect(
      result.candidates.some((candidate) =>
        candidate.path.includes('evaluation'),
      ),
    ).toBe(false);
  });

  test('recognizes evaluation artifacts and change patches', () => {
    expect(
      isEvaluationArtifactPath('fixtures/order-api/evaluation/cases.json'),
    ).toBe(true);
    expect(
      isEvaluationArtifactPath('fixtures/order-api/changes/buggy.patch'),
    ).toBe(true);
    expect(isEvaluationArtifactPath('src/api.ts')).toBe(false);
  });
});
