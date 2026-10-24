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
      'docs/ai-development-validation.md',
      'docs/requirement-planning.md',
      'docs/isolated-execution.md',
      'fixtures/order-api/README.md',
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
    expect(spec).toContain('## 実装済みの要件抽出と検証シナリオ計画（#24）');
    expect(readme).toContain('docs/requirement-planning.md');
  });

  test('documents the implemented isolated execution contract', () => {
    const isolation = readRepoFile('docs/isolated-execution.md');
    expect(spec).toContain(
      '## 実装済みのテスト生成・隔離実行・証拠収集（#25）',
    );
    expect(isolation).toContain('## 隔離方式と安全境界');
    expect(isolation).toContain('## 依存準備');
    expect(isolation).toContain('生成テスト不正');
    expect(isolation).toContain('テスト通信は既定で遮断');
    expect(isolation).toContain('コンテナではありません');
  });

  test('documents the implemented verification report contract', () => {
    const isolation = readRepoFile('docs/isolated-execution.md');
    expect(spec).toContain('## 実装済みの検証レポート（#26）');
    expect(spec).toContain('schemaVersion: "1"');
    expect(spec).toContain('worst-condition-state');
    expect(spec).toContain('verification: "partial"');
    expect(spec).toContain('終了コード2');
    expect(isolation).toContain('## レポート（#26）');
    expect(isolation).toContain('要件全体・コード全体の正しさ');
  });

  test('documents permission reuse, data contract, and replan steps', () => {
    const planning = readRepoFile('docs/requirement-planning.md');
    expect(planning).toContain('## 許可profile');
    expect(planning).toContain('## データ契約');
    expect(planning).toContain('## 人の確認・修正・再計画');
    expect(planning).toContain('実APIの品質評価は別');
  });
});
