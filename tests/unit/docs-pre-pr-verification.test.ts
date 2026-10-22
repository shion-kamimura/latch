import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const readRepoFile = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const spec = readRepoFile('docs/pre-pr-verification.md');
const readme = readRepoFile('README.md');

describe('pre-PR verification spec', () => {
  test('README links to the spec', () => {
    expect(readme).toContain('docs/pre-pr-verification.md');
  });

  test('local document links resolve inside the repository', () => {
    for (const document of [
      'README.md',
      'AGENTS.md',
      'docs/pre-pr-verification.md',
    ]) {
      for (const match of readRepoFile(document).matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1]?.split('#')[0];
        if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
        const source = new URL(`../../${document}`, import.meta.url);
        expect(
          existsSync(new URL(target, source)),
          `${document}: ${target}`,
        ).toBe(true);
      }
    }
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
