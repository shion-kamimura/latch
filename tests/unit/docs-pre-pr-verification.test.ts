import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const readRepoFile = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const spec = readRepoFile('docs/pre-pr-verification.md');
const readme = readRepoFile('README.md');

describe('pre-PR verification spec', () => {
  test('README links to the spec', () => {
    expect(readme).toContain('docs/pre-pr-verification.md');
  });

  test('documents local and CI usage examples', () => {
    expect(spec).toContain('## CIでの利用例');
    expect(spec).toContain('latch verify --base');
    expect(spec).toContain('Draft PR');
  });

  test('documents committed, uncommitted, and untracked file handling', () => {
    expect(spec).toContain('| コミット済み |');
    expect(spec).toContain('| 未コミット   |');
    expect(spec).toContain('| 未追跡       |');
    expect(spec).toMatch(/未追跡.*含めない/);
  });

  test('documents Issue input methods and invalid input handling', () => {
    expect(spec).toContain('--issue <番号>');
    expect(spec).toContain('--issue-file <path>');
    expect(spec).toContain('入力不正');
    expect(spec).toContain('入力不足');
  });

  test('documents requirement, test, evidence, and unverified mapping', () => {
    expect(spec).toContain('## 出力例');
    expect(spec).toContain('Requirements');
    expect(spec).toContain('Coverage');
    expect(spec).toContain('Not verified');
  });

  test('documents isolation and source immutability policy', () => {
    expect(spec).toContain('## 隔離実行と変更禁止の方針');
    expect(spec).toContain('対象ソースを勝手に変更しない');
  });

  test('documents follow-up issues and open questions', () => {
    expect(spec).toContain('## 後続の実装Issueへの分割案');
    expect(spec).toContain('## 未決定事項');
  });

  test('keeps implementation status honest', () => {
    expect(spec).toContain('未実装');
  });
});
