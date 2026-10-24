import { RequirementPlanError } from '../plan/errors.js';
import {
  authorizePlanningScope,
  defaultExecutionSettings,
  loadPlanningProfile,
  resolveApiKey,
} from '../plan/profile.js';
import type { DataCategory, ExecutionSettings } from '../plan/types.js';
import { sha256 } from '../verify/files.js';
import { resolveVerificationInputs } from '../verify/resolve-inputs.js';
import {
  generateTests,
  repairGeneratedTest,
  type GenerationContext,
} from './generate.js';
import {
  assertIsolationSupported,
  createIsolatedWorkspace,
  writeGeneratedTest,
} from './isolation.js';
import { executeSuite } from './execute.js';
import { readRunPlan } from './plan-file.js';
import {
  deriveConditionOutcomes,
  REPORT_DISCLAIMER,
  RUN_REPORT_SCHEMA_VERSION,
  summarizeRequirements,
} from './report.js';
import type {
  Evidence,
  GeneratedTest,
  RunEnvironment,
  RunOptions,
  RunPlanInput,
  RunReport,
} from './types.js';

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replace(/'/gu, `'\\''`)}'`;
}

function categoriesFor(
  runPlan: RunPlanInput,
  settings: ExecutionSettings,
): DataCategory[] {
  const categories: DataCategory[] = [];
  if (runPlan.plan.input.issue !== null) categories.push('issue');
  if (runPlan.plan.input.diff.files.length > 0) categories.push('diff');
  if (runPlan.plan.testCandidates.length > 0) categories.push('tests');
  if (categories.length === 0) categories.push('diff');
  void settings;
  return categories;
}

function planConditionsById(runPlan: RunPlanInput) {
  return new Map(
    runPlan.conditions.map((condition) => [condition.id, condition]),
  );
}

function existingConditionIds(
  runPlan: RunPlanInput,
  file: string,
  name: string,
): string[] {
  return [
    ...new Set(
      runPlan.plan.testCandidates
        .filter(
          (candidate) =>
            candidate.path === file &&
            (candidate.name === name || name.includes(candidate.name)),
        )
        .flatMap((candidate) => candidate.matchedConditionIds),
    ),
  ];
}

function generatedConditionIds(
  tests: readonly GeneratedTest[],
  file: string,
): string[] {
  const test = tests.find(
    (item) => item.file === file || file.endsWith(item.file),
  );
  return test ? [test.conditionId] : [];
}

function reportDigest(report: Omit<RunReport, 'digest'>): string {
  return sha256(
    [
      'latch-verification-report-v1',
      `schema:${report.schemaVersion}`,
      `input:${JSON.stringify(report.input)}`,
      `requirements:${JSON.stringify(report.requirements)}`,
      `conditions:${JSON.stringify(report.conditions)}`,
      `evidence:${JSON.stringify(report.evidence)}`,
      `verification:${report.verification}`,
      `partial:${JSON.stringify(report.partialReasons)}`,
      `warnings:${JSON.stringify(report.warnings)}`,
    ].join('\n'),
  );
}

export async function runVerification(
  options: RunOptions,
  environment: RunEnvironment,
): Promise<RunReport> {
  const runPlan = readRunPlan(options.plan, environment.cwd);
  const plan = runPlan.plan;
  const rawPlanOptions = plan.input.options;
  const planOptions = {
    base: rawPlanOptions?.base ?? plan.input.base.ref,
    issueFile: rawPlanOptions?.issueFile ?? plan.input.issue?.path ?? null,
    includeUntracked: rawPlanOptions?.includeUntracked ?? [],
  };
  const snapshot = resolveVerificationInputs(
    {
      ...(planOptions.base === null ? {} : { base: planOptions.base }),
      ...(planOptions.issueFile === null
        ? {}
        : { issueFile: planOptions.issueFile }),
      includeUntracked: planOptions.includeUntracked,
      json: false,
    },
    environment.cwd,
  );
  if (snapshot.digest !== plan.input.snapshotDigest) {
    throw new RequirementPlanError(
      '計画ファイルの入力スナップショットが現在の入力と一致しません。',
      '変更を固定してから latch plan を再実行し、新しい計画で latch run を実行してください。',
      1,
    );
  }
  if (snapshot.repository.root !== plan.input.repository.root) {
    throw new RequirementPlanError(
      '計画ファイルのリポジトリと実行中のリポジトリが一致しません。',
      '計画を作成したリポジトリで実行してください。',
      1,
    );
  }

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
  const settings = profile.execution ?? defaultExecutionSettings();
  if (settings.network.allowedDestinations.length > 0) {
    throw new RequirementPlanError(
      'テスト通信の許可先が設定されていますが、この段階では宛先単位の通信許可を実装していません。',
      'MVPではテスト通信を既定で遮断します。allowedDestinationsを空にしてから再実行してください。',
    );
  }

  const categories = categoriesFor(runPlan, settings);
  authorizePlanningScope(profile, {
    provider: profile.connection.provider,
    endpoint: profile.connection.endpoint,
    project: snapshot.repository.root,
    dataCategories: categories,
  });
  const apiKey = resolveApiKey(profile, environment.env);
  assertIsolationSupported();

  const generationContext: GenerationContext = {
    profile,
    apiKey,
    fetch: environment.fetch,
    snapshot,
    runPlan,
  };
  const generation = await generateTests(generationContext);
  const generated = [...generation.tests];
  let requestCount = generation.requestCount;
  let repairAttempts = 0;

  const workspace = createIsolatedWorkspace(snapshot, settings);
  const evidence: Evidence[] = [];
  const warnings = [
    ...snapshot.warnings,
    ...generation.warnings,
    '対象コードはホストで直接実行せず、固定入力の隔離コピーで実行しました。',
    'テスト通信はNode.jsのパーミッションモデルで遮断しました。',
    ...(settings.dependencies.mode === 'runner'
      ? [
          '対象の依存はインストールせず、LatchのVitestだけを隔離コピーへリンクしました。',
        ]
      : []),
  ];
  const conditions = planConditionsById(runPlan);
  let executionFailure = false;

  try {
    for (const test of generated) {
      writeGeneratedTest(workspace, test.file, test.code);
    }

    const existingPaths = [
      ...new Set(
        runPlan.plan.testCandidates.map((candidate) => candidate.path),
      ),
    ].filter((path) => path.startsWith('.latch/') === false);
    if (existingPaths.length > 0) {
      const existing = executeSuite({
        workspace,
        settings,
        include: existingPaths,
        name: 'existing',
        kind: 'existing',
        conditionIdsByTest: (file, name) =>
          existingConditionIds(runPlan, file, name),
      });
      evidence.push(...existing.evidence);
      if (existing.setupFailure) {
        warnings.push(
          '既存テストの実行が起動失敗または環境不足で完了しませんでした。',
        );
      }
      if (
        existing.status === 'runner-startup-failed' ||
        existing.status === 'environment-insufficient' ||
        existing.status === 'timeout'
      ) {
        executionFailure = true;
      }
    }

    for (let index = 0; index < generated.length; index += 1) {
      let current = generated[index]!;
      let attempt = 0;
      let result = executeSuite({
        workspace,
        settings,
        include: [current.file],
        name: `generated-${index + 1}-attempt-${attempt}`,
        kind: 'generated',
        conditionIdsByTest: (file) => generatedConditionIds([current], file),
      });

      while (
        result.status === 'invalid-generated-test' &&
        attempt < settings.limits.maxRepairAttempts
      ) {
        const condition = conditions.get(current.conditionId)!;
        const repaired = await repairGeneratedTest(
          generationContext,
          current,
          condition,
          result.evidence[0]?.log ?? '',
        );
        requestCount += repaired.requestCount;
        repairAttempts += 1;
        current = repaired.test;
        generated[index] = current;
        writeGeneratedTest(workspace, current.file, current.code);
        attempt += 1;
        result = executeSuite({
          workspace,
          settings,
          include: [current.file],
          name: `generated-${index + 1}-attempt-${attempt}`,
          kind: 'generated',
          conditionIdsByTest: (file) => generatedConditionIds([current], file),
        });
      }

      evidence.push(...result.evidence);
      if (result.status === 'invalid-generated-test') {
        warnings.push(
          `生成テスト ${current.conditionId} は実行可能なテストとして解釈できませんでした。`,
        );
      }
      if (result.status === 'timeout') {
        warnings.push(
          `生成テスト ${current.conditionId} は時間上限を超えたため終了しました。`,
        );
      }
      if (
        result.status === 'runner-startup-failed' ||
        result.status === 'environment-insufficient' ||
        result.status === 'timeout'
      ) {
        executionFailure = true;
      }
    }

    const evidenceWithContent: Evidence[] = evidence.map((item) => {
      if (item.kind !== 'generated') return item;
      const test = generated.find(
        (candidate) =>
          candidate.file === item.file || item.file.endsWith(candidate.file),
      );
      return { ...item, content: test?.code ?? null };
    });
    const outcomes = deriveConditionOutcomes(runPlan, evidenceWithContent);
    const requirements = summarizeRequirements(runPlan.conditions, outcomes);
    const cleanup = workspace.cleanup();
    const partialReasons: string[] = [];
    if (executionFailure) {
      partialReasons.push(
        'テストの起動・実行環境または時間上限により判定できない条件があります。',
      );
    }
    if (outcomes.some((outcome) => outcome.state === 'execution-impossible')) {
      partialReasons.push('実行不能・判定不能の条件があります。');
    }
    if (cleanup.status === 'failed') {
      partialReasons.push('隔離領域の後片付けに失敗しました。');
    }
    const verification = partialReasons.length === 0 ? 'completed' : 'partial';
    const unverified = [
      '隔離はプロセス境界と一時コピーであり、コンテナ等のOSレベル分離ではありません。',
      '生成テストはLLMの解釈を含み、要件の網羅性や正しさを保証しません。',
      '実APIでのテスト生成品質は評価していません。',
      '既存テスト候補は条件を十分に確認できるとは限りません。',
      ...(settings.dependencies.mode === 'runner'
        ? [
            '対象リポジトリの依存関係は準備せず、LatchのVitestのみを利用しました。',
          ]
        : []),
      ...(generation.tests.length === 0
        ? ['生成テストを作成していない条件は未検証です。']
        : []),
    ];
    if (cleanup.status === 'failed') {
      warnings.push(cleanup.note);
    }

    const baseReport: Omit<RunReport, 'digest'> = {
      schemaVersion: RUN_REPORT_SCHEMA_VERSION,
      phase: 'isolated-execution',
      verification,
      input: {
        repository: snapshot.repository.root,
        head: snapshot.repository.head,
        baseRef: snapshot.base.ref,
        baseCommit: snapshot.base.commit,
        mergeBase: snapshot.base.mergeBase,
        snapshotDigest: snapshot.digest,
        planPath: runPlan.path,
        planDigest: plan.digest,
        diff: {
          digest: snapshot.diff.digest,
          files: snapshot.diff.files,
          excluded: snapshot.diff.excluded,
          untracked: snapshot.diff.untracked.map((file) => file.path),
          kinds: {
            committed: snapshot.diff.files.filter(
              (file) => file.kind === 'committed',
            ).length,
            uncommitted: snapshot.diff.files.filter(
              (file) => file.kind === 'uncommitted',
            ).length,
            untracked: snapshot.diff.untracked.length,
          },
        },
        issue:
          snapshot.issue === null
            ? {
                input: 'none',
                path: null,
                title: null,
                state: null,
                source: null,
                digest: null,
              }
            : {
                input: 'issue-file',
                path: snapshot.issue.path,
                title: snapshot.issue.title,
                state: snapshot.issue.state,
                source: snapshot.issue.source,
                digest: snapshot.issue.digest,
              },
        reproducibility: snapshot.reproducibility,
      },
      generation: {
        provider: profile.connection.provider,
        model: profile.connection.model,
        requestCount,
        maxRequests: profile.limits.maxRequests,
        repairAttempts,
        maxRepairAttempts: settings.limits.maxRepairAttempts,
        requestedConditions: runPlan.conditions.filter(
          (condition) =>
            condition.ambiguity === null &&
            condition.missingScenarios.length > 0,
        ).length,
        generatedFiles: generated.length,
      },
      isolation: {
        mode: 'process',
        root: '<temporary>',
        network: 'blocked',
        credentials: 'not-forwarded',
        dependencyMode: workspace.dependencyMode,
        runner: '<latch-vitest>',
        copiedFiles: workspace.copiedFiles,
        excluded: workspace.excluded,
        limits: {
          timeoutMs: settings.limits.timeoutMs,
          maxMemoryMb: settings.limits.maxMemoryMb,
          maxOutputBytes: settings.limits.maxOutputBytes,
        },
        cleanup,
      },
      requirements,
      conditions: outcomes,
      evidence: evidenceWithContent,
      unverified,
      warnings,
      partialReasons,
      disclaimer: REPORT_DISCLAIMER,
      rerunCommand: [
        'latch',
        'run',
        '--plan',
        quote(runPlan.path),
        '--profile',
        quote(profile.path),
        ...(options.json ? ['--json'] : []),
      ].join(' '),
    };
    return { ...baseReport, digest: reportDigest(baseReport) };
  } catch (error) {
    workspace.cleanup();
    throw error;
  }
}
