import type {
  ExtractedRequirement,
  PlanState,
  RequirementPlan,
  SourceReference,
} from './types.js';

const stateLabels: Record<PlanState, string> = {
  unverified: '未検証',
  ambiguous: '要件不明確',
};

const originLabels = {
  'issue-explicit': 'Issue明示',
  'diff-inferred': '差分推定',
} as const;

function sourceLabel(source: SourceReference): string {
  return source.label;
}

function indent(text: string, prefix: string): string[] {
  return text.split('\n').map((line) => `${prefix}${line}`);
}

function section(title: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  return [title, ...lines, ''];
}

function requirementLines(requirement: ExtractedRequirement): string[] {
  const lines = [
    `  ${requirement.id} [${stateLabels[requirement.state]}] ${requirement.text}`,
    `    出典: ${sourceLabel(requirement.source)}（${originLabels[requirement.origin]}）`,
  ];
  if (requirement.ambiguity) {
    lines.push(...indent(`不明確: ${requirement.ambiguity}`, '    '));
  }
  for (const condition of requirement.conditions) {
    lines.push(
      `    ${condition.id} [${stateLabels[condition.state]}] ${condition.text}`,
      `      出典: ${sourceLabel(condition.source)}（${originLabels[condition.origin]}）`,
    );
    if (condition.ambiguity) {
      lines.push(...indent(`不明確: ${condition.ambiguity}`, '      '));
    }
    if (condition.existingTestCandidateIds.length === 0) {
      lines.push('      既存テスト候補: なし');
    } else {
      lines.push(
        `      既存テスト候補: ${condition.existingTestCandidateIds.join(', ')}`,
      );
    }
    if (condition.missingScenarios.length === 0) {
      lines.push('      不足シナリオ: なし');
    }
    for (const scenario of condition.missingScenarios) {
      lines.push(
        `      不足シナリオ ${scenario.id} [${stateLabels[scenario.state]}] ${scenario.description}`,
      );
      if (scenario.rationale) {
        lines.push(...indent(`理由: ${scenario.rationale}`, '        '));
      }
      lines.push('        実行証拠: なし（候補・計画のみ）');
    }
  }
  return lines;
}

export function renderPlanText(plan: RequirementPlan): string {
  const lines: string[] = [
    'Latch requirement plan',
    '',
    '入力',
    `  リポジトリ: ${plan.input.repository.root}`,
    `  HEAD: ${plan.input.repository.head}`,
    `  base: ${plan.input.base.ref}`,
    `  比較基点: ${plan.input.base.mergeBase}（merge-base）`,
    ...(plan.input.issue
      ? [
          `  Issue: ${plan.input.issue.path}`,
          `    タイトル: ${plan.input.issue.title}`,
          `    状態: ${plan.input.issue.state}`,
          `    出典: ${plan.input.issue.source}`,
        ]
      : ['  Issue: 指定なし（差分からの推定に限られます）']),
    `  差分ファイル: ${plan.input.diff.files.length} 件`,
    `  スナップショット: sha256:${plan.input.snapshotDigest}`,
    '',
    '送信許可',
    `  profile: ${plan.permission.profileId}`,
    `  provider: ${plan.permission.provider}`,
    `  project: ${plan.permission.project}`,
    `  データ区分: ${plan.permission.dataCategories.join(', ')}`,
    '  認証は公式CLIへ委譲し、認証情報は読取・保存していません。',
    '',
    'LLM',
    `  model: ${plan.llm.model}`,
    `  呼び出し回数: ${plan.llm.requestCount} / 上限 ${plan.llm.maxRequests}`,
    `  timeout: ${plan.llm.timeoutMs}ms`,
    '',
  ];

  lines.push(
    ...section('要件と条件', plan.requirements.flatMap(requirementLines)),
  );

  lines.push(
    ...section(
      '既存テスト候補（未実行）',
      plan.testCandidates.map(
        (candidate) =>
          `  ${candidate.id} [${candidate.framework}] ${candidate.path} :: ${candidate.name}${
            candidate.matchedConditionIds.length > 0
              ? `（対応候補: ${candidate.matchedConditionIds.join(', ')}）`
              : '（対応条件なし）'
          }`,
      ),
    ),
  );

  lines.push(
    ...section(
      '未検証・要件不明確',
      plan.unverified.map((item) => `  - ${item}`),
    ),
  );

  lines.push(
    ...section(
      'メモ',
      plan.notes.map((note) => `  - ${note}`),
    ),
  );

  lines.push(
    ...section(
      '警告',
      plan.warnings.map((warning) => `  - ${warning}`),
    ),
  );

  lines.push(
    '再実行',
    `  ${plan.rerunCommand}`,
    '',
    '要件抽出と検証計画のみを行いました。テスト生成・実行・検証は行っていません。',
    '既存テスト候補と実行証拠を混同せず、要件不明確は人の確認対象として残してください。',
    '',
  );

  return lines.join('\n');
}

export function renderPlanJson(plan: RequirementPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}
