import type {
  ConditionOutcome,
  Evidence,
  EvidenceStatus,
  RunReport,
} from './types.js';

const conditionLabels: Record<ConditionOutcome['state'], string> = {
  verified: '検証成功',
  failed: '検証失敗',
  unverified: '未検証',
  ambiguous: '要件不明確',
  'execution-impossible': '実行不能・判定不能',
};

const evidenceLabels: Record<EvidenceStatus, string> = {
  passed: '成功',
  'assertion-failed': 'アサーション失敗',
  'invalid-generated-test': '生成テスト不正',
  'runner-startup-failed': '起動失敗',
  'environment-insufficient': '環境不足',
  timeout: '時間上限超過',
  skipped: '未実行',
};

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [title, ...lines, ''];
}

function indent(text: string, prefix: string): string[] {
  return text.split('\n').map((line) => `${prefix}${line}`);
}

function conditionLines(outcome: ConditionOutcome): string[] {
  const lines = [
    `  ${outcome.conditionId} [${conditionLabels[outcome.state]}]`,
    `    要件: ${outcome.requirementId}`,
    `    証拠: ${outcome.evidenceIds.length > 0 ? outcome.evidenceIds.join(', ') : 'なし'}`,
  ];
  for (const note of outcome.notes) lines.push(...indent(`- ${note}`, '    '));
  return lines;
}

function evidenceLines(evidence: Evidence): string[] {
  const lines = [
    `  ${evidence.id} [${evidence.kind === 'generated' ? '生成' : '既存'}] [${evidenceLabels[evidence.status]}]`,
    `    テスト: ${evidence.testName}`,
    `    ファイル: ${evidence.file}`,
    `    条件: ${evidence.conditionIds.length > 0 ? evidence.conditionIds.join(', ') : '対応なし'}`,
    `    コマンド: ${evidence.command}`,
    `    終了コード: ${evidence.exitCode === null ? 'null' : evidence.exitCode}${
      evidence.signal === null ? '' : `（signal: ${evidence.signal}）`
    }`,
    `    実行時間: ${evidence.durationMs}ms`,
  ];
  if (evidence.content !== null) {
    const content =
      evidence.content.length > 4_000
        ? `${evidence.content.slice(0, 4_000)}\n...[truncated]`
        : evidence.content;
    lines.push('    生成テスト内容:', ...indent(content, '      '));
  }
  const log =
    evidence.log.length > 4_000
      ? `${evidence.log.slice(0, 4_000)}\n...[truncated]`
      : evidence.log;
  lines.push(
    `    ログ${evidence.logTruncated ? '（保存時に切り詰め）' : ''}:`,
    ...indent(log.length > 0 ? log : '(no output)', '      '),
  );
  return lines;
}

export function renderRunText(report: RunReport): string {
  const generated = report.evidence.filter((item) => item.kind === 'generated');
  const existing = report.evidence.filter((item) => item.kind === 'existing');
  const lines: string[] = ['Latch isolated execution report', ''];

  lines.push(
    ...section('入力', [
      `  リポジトリ: ${report.input.repository}`,
      `  HEAD: ${report.input.head}`,
      `  base: ${report.input.baseRef}`,
      `  比較基点: ${report.input.mergeBase}（merge-base）`,
      `  スナップショット: sha256:${report.input.snapshotDigest}`,
      `  計画: ${report.input.planPath}`,
      `  計画digest: ${report.input.planDigest}`,
    ]),
  );

  lines.push(
    ...section('生成', [
      `  provider: ${report.generation.provider}`,
      `  model: ${report.generation.model}`,
      `  呼び出し回数: ${report.generation.requestCount}（1回あたり上限 ${report.generation.maxRequests}）`,
      `  生成修正: ${report.generation.repairAttempts} / 上限 ${report.generation.maxRepairAttempts}`,
      `  対象条件: ${report.generation.requestedConditions}`,
      `  生成ファイル: ${report.generation.generatedFiles}`,
    ]),
  );

  lines.push(
    ...section('隔離', [
      `  方式: ${report.isolation.mode}（一時コピーとNode.jsパーミッションモデル）`,
      `  入力コピー: ${report.isolation.copiedFiles} ファイル`,
      `  依存準備: ${report.isolation.dependencyMode}`,
      `  上限: ${report.isolation.limits.timeoutMs}ms / ${report.isolation.limits.maxMemoryMb}MB / ${report.isolation.limits.maxOutputBytes}bytes`,
      `  テスト通信: ${report.isolation.network}`,
      `  資格情報: ${report.isolation.credentials}`,
      ...(report.isolation.excluded.length > 0
        ? [`  除外: ${report.isolation.excluded.join(', ')}`]
        : []),
      `  後片付け: ${report.isolation.cleanup.status}（${report.isolation.cleanup.note}）`,
    ]),
  );

  lines.push(
    ...section('条件別の状態', report.conditions.flatMap(conditionLines)),
  );

  lines.push(
    ...section('実行証拠（生成テスト）', generated.flatMap(evidenceLines)),
  );
  lines.push(
    ...section('実行証拠（既存テスト）', existing.flatMap(evidenceLines)),
  );

  lines.push(
    ...section(
      '未検証事項',
      report.unverified.map((item) => `  - ${item}`),
    ),
  );
  lines.push(
    ...section(
      '警告',
      report.warnings.map((item) => `  - ${item}`),
    ),
  );

  lines.push(
    '再実行',
    `  ${report.rerunCommand}`,
    '',
    'テスト成功は要件全体・コード全体の正しさの証明ではありません。',
    '生成テスト不正・起動失敗・環境不足を製品不具合の証拠として扱っていません。',
    '',
  );

  return lines.join('\n');
}

export function renderRunJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
