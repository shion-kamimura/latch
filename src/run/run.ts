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
import type {
  ConditionOutcome,
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

function conditionOutcomes(
  runPlan: RunPlanInput,
  evidence: readonly Evidence[],
): ConditionOutcome[] {
  return runPlan.conditions.map((condition) => {
    const conditionEvidence = evidence.filter((item) =>
      item.conditionIds.includes(condition.id),
    );
    const evidenceIds = conditionEvidence.map((item) => item.id);
    if (condition.ambiguity !== null) {
      return {
        conditionId: condition.id,
        requirementId: condition.requirementId,
        state: 'ambiguous',
        evidenceIds,
        notes: ['要件不明確のため、実行結果があっても検証成功とはしません。'],
      };
    }

    const failed = conditionEvidence.some(
      (item) => item.status === 'assertion-failed',
    );
    if (failed) {
      return {
        conditionId: condition.id,
        requirementId: condition.requirementId,
        state: 'failed',
        evidenceIds,
        notes: ['実行したテストが失敗しました。'],
      };
    }

    const generated = conditionEvidence.filter(
      (item) => item.kind === 'generated',
    );
    const passedGenerated = generated.some((item) => item.status === 'passed');
    if (passedGenerated) {
      return {
        conditionId: condition.id,
        requirementId: condition.requirementId,
        state: 'verified',
        evidenceIds,
        notes: ['生成テストが成功しました。要件全体の正しさを証明しません。'],
      };
    }

    const impossible = conditionEvidence.find(
      (item) =>
        item.status === 'runner-startup-failed' ||
        item.status === 'environment-insufficient' ||
        item.status === 'timeout',
    );
    if (impossible) {
      return {
        conditionId: condition.id,
        requirementId: condition.requirementId,
        state: 'execution-impossible',
        evidenceIds,
        notes: ['実行環境または起動の失敗により判定できません。'],
      };
    }

    const invalid = conditionEvidence.find(
      (item) => item.status === 'invalid-generated-test',
    );
    if (invalid) {
      return {
        conditionId: condition.id,
        requirementId: condition.requirementId,
        state: 'unverified',
        evidenceIds,
        notes: [
          '生成テストが実行可能なテストになっていません。製品不具合の証拠として扱いません。',
        ],
      };
    }

    const existingPassed = conditionEvidence.some(
      (item) => item.kind === 'existing' && item.status === 'passed',
    );
    if (existingPassed) {
      return {
        conditionId: condition.id,
        requirementId: condition.requirementId,
        state: 'unverified',
        evidenceIds,
        notes: [
          '既存テスト候補は成功しましたが、条件を十分に確認したとは限りません。',
        ],
      };
    }

    return {
      conditionId: condition.id,
      requirementId: condition.requirementId,
      state: 'unverified',
      evidenceIds,
      notes: ['この条件に対応する実行証拠がありません。'],
    };
  });
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
      'latch-isolated-execution-v1',
      `snapshot:${report.input.snapshotDigest}`,
      `plan:${report.input.planDigest}`,
      `conditions:${JSON.stringify(report.conditions)}`,
      `evidence:${JSON.stringify(report.evidence)}`,
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
    );
  }
  if (snapshot.repository.root !== plan.input.repository.root) {
    throw new RequirementPlanError(
      '計画ファイルのリポジトリと実行中のリポジトリが一致しません。',
      '計画を作成したリポジトリで実行してください。',
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
    }

    const evidenceWithContent: Evidence[] = evidence.map((item) => {
      if (item.kind !== 'generated') return item;
      const test = generated.find(
        (candidate) =>
          candidate.file === item.file || item.file.endsWith(candidate.file),
      );
      return { ...item, content: test?.code ?? null };
    });
    const outcomes = conditionOutcomes(runPlan, evidenceWithContent);
    const cleanup = workspace.cleanup();
    const verification =
      outcomes.some((outcome) => outcome.state === 'execution-impossible') ||
      cleanup.status === 'failed'
        ? 'incomplete'
        : 'completed';
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
      phase: 'isolated-execution',
      verification,
      input: {
        repository: snapshot.repository.root,
        head: snapshot.repository.head,
        baseRef: snapshot.base.ref,
        mergeBase: snapshot.base.mergeBase,
        snapshotDigest: snapshot.digest,
        planPath: runPlan.path,
        planDigest: plan.digest,
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
      conditions: outcomes,
      evidence: evidenceWithContent,
      unverified,
      warnings,
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
