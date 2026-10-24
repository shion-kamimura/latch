import { sha256 } from '../verify/files.js';
import { resolveVerificationInputs } from '../verify/resolve-inputs.js';
import { RequirementPlanError } from './errors.js';
import { callPlanningLlm } from './llm.js';
import { normalizeLlmResponse } from './normalize.js';
import {
  authorizePlanningScope,
  loadPlanningProfile,
  resolveApiKey,
} from './profile.js';
import { buildPlanningPrompt, type PromptContext } from './prompt.js';
import {
  discoverVitestCandidates,
  isEvaluationArtifactPath,
  type DiscoveredTestCandidate,
} from './test-candidates.js';
import type {
  DataCategory,
  PlanEnvironment,
  PlanOptions,
  RequirementPlan,
  VerificationInputSnapshot,
} from './types.js';

const MAX_SENSITIVE_WARNINGS = 10;

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replace(/'/gu, `'\\''`)}'`;
}

function rerunCommand(
  options: PlanOptions,
  snapshot: VerificationInputSnapshot,
  profilePath: string,
): string {
  const parts = ['latch', 'plan', '--profile', quote(profilePath)];
  parts.push('--base', quote(options.base ?? snapshot.base.ref));
  if (options.issueFile !== undefined) {
    parts.push('--issue-file', quote(options.issueFile));
  }
  for (const path of options.includeUntracked) {
    parts.push('--include-untracked', quote(path));
  }
  if (options.json) parts.push('--json');
  return parts.join(' ');
}

function filterDiffText(
  text: string,
  allowedPaths: ReadonlySet<string>,
): { text: string; dropped: string[] } {
  if (text.length === 0) return { text: '', dropped: [] };
  const sections = text.split(/^(?=diff --git )/mu);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const section of sections) {
    if (!section.startsWith('diff --git ')) continue;
    const header = section.split('\n', 1)[0] ?? '';
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(header);
    const path = match?.[2] ?? match?.[1];
    if (!path) {
      dropped.push(header.slice(0, 200));
      continue;
    }
    if (!allowedPaths.has(path)) {
      dropped.push(path);
      continue;
    }
    kept.push(section);
  }
  return { text: kept.join(''), dropped };
}

function sensitiveWarnings(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const unique = [...new Set(paths)].sort();
  const warnings = [
    '#22の評価専用データ・正解データをLLM入力から除外しました。',
  ];
  for (const path of unique.slice(0, MAX_SENSITIVE_WARNINGS)) {
    warnings.push(`送信対象から除外: ${path}`);
  }
  if (unique.length > MAX_SENSITIVE_WARNINGS) {
    warnings.push(
      `送信対象から除外: ほか ${unique.length - MAX_SENSITIVE_WARNINGS} 件`,
    );
  }
  return warnings;
}

export function buildPromptContext(
  snapshot: VerificationInputSnapshot,
  testCandidates: readonly DiscoveredTestCandidate[],
): {
  readonly context: PromptContext;
  readonly warnings: string[];
} {
  const allChangedPaths = snapshot.diff.files.map((file) => file.path);
  const sensitivePaths = allChangedPaths.filter(isEvaluationArtifactPath);
  const allowedPaths = new Set(
    allChangedPaths.filter((path) => !isEvaluationArtifactPath(path)),
  );
  const untracked = snapshot.diff.untracked.filter(
    (file) => !isEvaluationArtifactPath(file.path),
  );
  for (const file of snapshot.diff.untracked) {
    if (isEvaluationArtifactPath(file.path)) sensitivePaths.push(file.path);
    else allowedPaths.add(file.path);
  }

  const committed = filterDiffText(snapshot.diff.committed, allowedPaths);
  const uncommitted = filterDiffText(snapshot.diff.uncommitted, allowedPaths);
  const diffText = [committed.text, uncommitted.text]
    .filter(Boolean)
    .join('\n');

  return {
    context: {
      issue: snapshot.issue
        ? {
            path: snapshot.issue.path,
            state: snapshot.issue.state,
            content: snapshot.issue.content,
            lineCount: snapshot.issue.content.split('\n').length,
          }
        : null,
      diffText,
      untracked,
      testCandidates,
      changedDiffPaths: [...allowedPaths].sort(),
    },
    warnings: sensitiveWarnings([
      ...sensitivePaths,
      ...committed.dropped,
      ...uncommitted.dropped,
    ]),
  };
}

function defaultUnverified(snapshot: VerificationInputSnapshot): string[] {
  const items = [
    'LLMの抽出結果は解釈であり、実行証拠ではありません。',
    '既存テスト候補は実行しておらず、検証済み結果ではありません。',
    '不足シナリオは計画であり、テスト生成・実行・証拠収集は行っていません。',
    'LLM応答の品質・網羅性は評価データで評価していません。',
  ];
  if (snapshot.issue === null) {
    items.push(
      'Issueが指定されていないため、期待値を確定できない条件は要件不明確として残します。',
    );
  }
  if (snapshot.issue?.state.toLowerCase() === 'closed') {
    items.push(
      'Issueはclosedです。記録された過去要件を現在の達成として扱っていません。',
    );
  }
  if (!snapshot.reproducibility.ciReproducible) {
    items.push(
      '未コミットまたは明示した未追跡ファイルを含むため、この計画はCIで再現できない可能性があります。',
    );
  }
  return items;
}

function planDigest(plan: Omit<RequirementPlan, 'digest'>): string {
  return sha256(
    [
      'latch-requirement-plan-v1',
      `snapshot:${plan.input.snapshotDigest}`,
      `provider:${plan.llm.provider}`,
      `model:${plan.llm.model}`,
      `requirements:${JSON.stringify(plan.requirements)}`,
      `tests:${JSON.stringify(plan.testCandidates)}`,
      `unverified:${JSON.stringify(plan.unverified)}`,
      `warnings:${JSON.stringify(plan.warnings)}`,
    ].join('\n'),
  );
}

function categoriesFor(
  snapshot: VerificationInputSnapshot,
  testCandidates: readonly DiscoveredTestCandidate[],
  hasSendableDiff: boolean,
): DataCategory[] {
  const categories: DataCategory[] = [];
  if (snapshot.issue) categories.push('issue');
  if (hasSendableDiff) categories.push('diff');
  if (testCandidates.length > 0) categories.push('tests');
  return categories;
}

export async function planRequirements(
  options: PlanOptions,
  environment: PlanEnvironment,
): Promise<RequirementPlan> {
  const snapshot = resolveVerificationInputs(options, environment.cwd);
  const profilePath = options.profile ?? environment.env.LATCH_PROFILE;
  if (profilePath === undefined || profilePath.trim().length === 0) {
    throw new RequirementPlanError(
      '許可profileが指定されていません。',
      '--profile <path> または LATCH_PROFILE に、ワークツリー外の利用者管理設定を指定してください。',
    );
  }

  const profile = loadPlanningProfile(
    profilePath,
    snapshot.repository.root,
    environment.cwd,
  );
  const discovery = discoverVitestCandidates(snapshot.repository.root);
  const promptContext = buildPromptContext(snapshot, discovery.candidates);
  const hasSendableDiff =
    promptContext.context.diffText.length > 0 ||
    promptContext.context.untracked.length > 0;
  if (snapshot.issue === null && !hasSendableDiff) {
    throw new RequirementPlanError(
      '送信可能なIssue・差分がありません。',
      '#22の評価専用データを除いた差分を用意するか、--issue-file を指定してください。',
    );
  }

  const categories = categoriesFor(
    snapshot,
    discovery.candidates,
    hasSendableDiff,
  );
  if (categories.length === 0) {
    throw new RequirementPlanError(
      '許可範囲で送信できる入力がありません。',
      'Issue・差分・Vitestテスト候補のいずれかを入力に含めてください。',
    );
  }

  authorizePlanningScope(profile, {
    provider: profile.connection.provider,
    endpoint: profile.connection.endpoint,
    project: snapshot.repository.root,
    dataCategories: categories,
  });
  const apiKey = resolveApiKey(profile, environment.env);

  const prompt = buildPlanningPrompt(
    promptContext.context,
    profile.limits.maxInputCharacters,
  );
  const llm = await callPlanningLlm({
    profile,
    apiKey,
    system: prompt.system,
    user: prompt.user,
    fetch: environment.fetch,
  });
  const normalized = normalizeLlmResponse(llm.content, {
    issuePath: snapshot.issue?.path ?? null,
    issueLineCount: snapshot.issue
      ? snapshot.issue.content.split('\n').length
      : 0,
    diffPaths: new Set(promptContext.context.changedDiffPaths),
    testCandidates: discovery.candidates,
  });

  const warnings = [
    ...snapshot.warnings,
    ...promptContext.warnings,
    ...discovery.warnings,
    ...(prompt.truncated
      ? [
          'LLMへ送る入力が上限を超えたため、一部を切り詰めました。未確認事項として扱ってください。',
        ]
      : []),
  ];
  if (snapshot.issue?.state.toLowerCase() === 'closed') {
    warnings.push(
      'Issueはclosedです。要件の状態・出典を保持し、現在の要件達成とは区別してください。',
    );
  }

  const unverified = [...defaultUnverified(snapshot), ...normalized.unverified];

  const basePlan: Omit<RequirementPlan, 'digest'> = {
    phase: 'requirement-planning',
    verification: 'not-run',
    input: {
      repository: snapshot.repository,
      base: {
        ref: snapshot.base.ref,
        commit: snapshot.base.commit,
        mergeBase: snapshot.base.mergeBase,
      },
      issue: snapshot.issue
        ? {
            path: snapshot.issue.path,
            title: snapshot.issue.title,
            state: snapshot.issue.state,
            source: snapshot.issue.source,
          }
        : null,
      diff: {
        files: snapshot.diff.files,
        excluded: snapshot.diff.excluded,
        digest: snapshot.diff.digest,
      },
      options: {
        base: options.base ?? null,
        issueFile: options.issueFile ?? null,
        includeUntracked: options.includeUntracked,
      },
      snapshotDigest: snapshot.digest,
    },
    permission: {
      profileId: profile.id,
      profilePath: profile.path,
      provider: profile.connection.provider,
      endpoint: profile.connection.endpoint,
      project: snapshot.repository.root,
      dataCategories: categories,
    },
    llm: {
      provider: profile.connection.provider,
      model: profile.connection.model,
      requestCount: llm.requestCount,
      maxRequests: profile.limits.maxRequests,
      timeoutMs: profile.limits.timeoutMs,
    },
    requirements: normalized.requirements,
    testCandidates: normalized.testCandidates,
    unverified,
    notes: normalized.notes,
    warnings,
    rerunCommand: rerunCommand(options, snapshot, profile.path),
  };

  return {
    ...basePlan,
    digest: planDigest(basePlan),
  };
}
