import { formatLimit } from '../limits.js';
import { conditionStateLabels, conditionStates } from './report.js';
import { assertValidRunReport } from './schema.js';
import type {
  ConditionOutcome,
  Evidence,
  EvidenceStatus,
  RequirementOutcome,
  RunReport,
} from './types.js';

const verificationLabels: Record<RunReport['verification'], string> = {
  completed: '完了（失敗・未検証を含む）',
  partial: '部分結果（実行不能を含み未完了）',
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

const exclusionLabels = {
  credential: '認証情報のパス',
  binary: 'バイナリ',
  symlink: 'シンボリックリンク',
  submodule: 'submodule',
  'git-internal': '.git配下',
  'outside-boundary': 'リポジトリ境界外',
  'not-utf8': 'UTF-8以外',
} as const;

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [title, ...lines, ''];
}

function indent(text: string, prefix: string): string[] {
  return text.split('\n').map((line) => `${prefix}${line}`);
}

function interpretationLines(
  interpretation: ConditionOutcome['interpretation'],
): string[] {
  return [
    `    LLM解釈: ${interpretation.text}`,
    `    出典: ${interpretation.source.label}`,
  ];
}

function requirementLines(requirement: RequirementOutcome): string[] {
  const lines = [
    `  ${requirement.requirementId} [${conditionStateLabels[requirement.state]}]`,
    `    LLM解釈: ${requirement.interpretation.text}`,
    `    出典: ${requirement.interpretation.source.label}`,
    `    集約: ${requirement.aggregation}`,
    `    条件: ${requirement.conditionStates
      .map(
        (condition) =>
          `${condition.conditionId} [${conditionStateLabels[condition.state]}]`,
      )
      .join(', ')}`,
    `    内訳: ${conditionStates
      .map(
        (state) =>
          `${conditionStateLabels[state]} ${requirement.stateCounts[state]}`,
      )
      .join(' / ')}`,
  ];
  for (const note of requirement.notes) lines.push(`    - ${note}`);
  return lines;
}

function conditionLines(
  outcome: ConditionOutcome,
  evidenceById: ReadonlyMap<string, Evidence>,
): string[] {
  const evidence = outcome.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is Evidence => item !== undefined)
    .map(
      (item) =>
        `${item.id} [${item.kind === 'generated' ? '生成' : '既存'}] [${
          evidenceLabels[item.status]
        }]`,
    );
  const lines = [
    `  ${outcome.conditionId} [${conditionStateLabels[outcome.state]}]`,
    `    要件: ${outcome.requirementId}`,
    ...interpretationLines(outcome.interpretation),
    `    実行証拠: ${evidence.length > 0 ? evidence.join(', ') : 'なし'}`,
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
    lines.push(
      '    生成テスト内容（LLMの解釈）:',
      ...indent(content, '      '),
    );
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
  assertValidRunReport(report);
  const generated = report.evidence.filter((item) => item.kind === 'generated');
  const existing = report.evidence.filter((item) => item.kind === 'existing');
  const evidenceById = new Map(
    report.evidence.map((item) => [item.id, item] as const),
  );
  const lines: string[] = [
    'Latch verification report',
    `  schemaVersion: ${report.schemaVersion}`,
    `  検証: ${verificationLabels[report.verification]}`,
    '',
  ];

  if (report.verification === 'partial') {
    lines.push(
      ...section(
        '部分結果',
        report.partialReasons.map((reason) => `  - ${reason}`),
      ),
    );
  }

  lines.push(
    ...section('入力', [
      `  リポジトリ: ${report.input.repository}`,
      `  HEAD: ${report.input.head}`,
      `  base: ${report.input.baseRef} (${report.input.baseCommit})`,
      `  比較基点: ${report.input.mergeBase}（merge-base）`,
      `  スナップショット: sha256:${report.input.snapshotDigest}`,
      `  差分: sha256:${report.input.diff.digest}`,
      `  差分区分: コミット済み ${report.input.diff.kinds.committed} 件 / 未コミット ${report.input.diff.kinds.uncommitted} 件 / 未追跡（明示） ${report.input.diff.kinds.untracked} 件`,
      ...report.input.diff.files.map(
        (file) =>
          `    変更: ${file.status} ${file.path}（${
            file.kind === 'committed' ? 'コミット済み' : '未コミット'
          }）`,
      ),
      ...report.input.diff.untracked.map(
        (path) => `    未追跡（明示）: ${path}`,
      ),
      ...(report.input.diff.excluded.length > 0
        ? [
            `  除外: ${report.input.diff.excluded
              .map((file) => `${file.path}（${exclusionLabels[file.reason]}）`)
              .join(', ')}`,
          ]
        : ['  除外: なし']),
      `  Issue入力: ${
        report.input.issue.input === 'issue-file'
          ? report.input.issue.path
          : '指定なし'
      }`,
      ...(report.input.issue.input === 'issue-file'
        ? [
            `    Issueタイトル: ${report.input.issue.title}`,
            `    Issue状態: ${report.input.issue.state}`,
            `    Issue出典: ${report.input.issue.source}`,
          ]
        : []),
      `  計画: ${report.input.planPath}`,
      `  計画digest: sha256:${report.input.planDigest}`,
      `  再現性: ${
        report.input.reproducibility.ciReproducible ? 'あり' : 'なし'
      }`,
      ...report.input.reproducibility.notes.map((note) => `    - ${note}`),
    ]),
  );

  lines.push(
    ...section(
      '要件別の状態（集約）',
      report.requirements.flatMap(requirementLines),
    ),
  );

  lines.push(
    ...section('生成', [
      `  provider: ${report.generation.provider}`,
      `  model: ${report.generation.model}`,
      `  呼び出し回数: ${report.generation.requestCount}（このrunの上限 ${formatLimit(report.generation.maxRequests)}）`,
      `  生成修正合計: ${report.generation.repairAttempts}（1条件あたり上限 ${report.generation.maxRepairAttempts}）`,
      `  対象条件: ${report.generation.requestedConditions}`,
      `  生成ファイル: ${report.generation.generatedFiles}`,
    ]),
  );

  lines.push(
    ...section('隔離', [
      `  方式: ${report.isolation.mode}（一時コピーとNode.jsパーミッションモデル）`,
      `  入力コピー: ${report.isolation.copiedFiles} ファイル`,
      `  依存準備: ${report.isolation.dependencyMode}`,
      `  上限: 時間 ${formatLimit(report.isolation.limits.timeoutMs, 'ms')} / メモリ ${formatLimit(report.isolation.limits.maxMemoryMb, 'MB')} / 出力 ${formatLimit(report.isolation.limits.maxOutputBytes, 'bytes')}`,
      `  テスト通信: ${report.isolation.network}`,
      `  資格情報: ${report.isolation.credentials}`,
      ...(report.isolation.excluded.length > 0
        ? [`  除外: ${report.isolation.excluded.join(', ')}`]
        : []),
      `  後片付け: ${report.isolation.cleanup.status}（${report.isolation.cleanup.note}）`,
    ]),
  );

  lines.push(
    ...section(
      '条件と実行証拠の対応',
      report.conditions.flatMap((condition) =>
        conditionLines(condition, evidenceById),
      ),
    ),
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
    '注意',
    `  ${report.disclaimer}`,
    '  実行証拠はテスト名・コマンド・終了コード・ログです。要件・条件の文と生成テストの内容はLLMの解釈です。',
    '',
  );

  return lines.join('\n');
}

export function renderRunJson(report: RunReport): string {
  assertValidRunReport(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}
