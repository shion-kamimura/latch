import type {
  ConditionOutcome,
  ConditionState,
  ConditionStateSummary,
  Evidence,
  PlanConditionInput,
  RequirementOutcome,
  RunPlanInput,
} from './types.js';

export const RUN_REPORT_SCHEMA_VERSION = '1' as const;

export const REPORT_DISCLAIMER =
  'テスト成功は要件全体・コード全体の正しさの証明ではありません。要件・条件の文と生成テストの意図はLLMの解釈であり、実行証拠とは区別してください。';

export const conditionStateLabels: Record<ConditionState, string> = {
  verified: '検証成功',
  failed: '検証失敗',
  unverified: '未検証',
  ambiguous: '要件不明確',
  'execution-impossible': '実行不能・判定不能',
};

export const conditionStates: readonly ConditionState[] = [
  'verified',
  'failed',
  'unverified',
  'ambiguous',
  'execution-impossible',
];

const statePriority: Record<ConditionState, number> = {
  'execution-impossible': 0,
  failed: 1,
  ambiguous: 2,
  unverified: 3,
  verified: 4,
};

function interpretationOf(condition: PlanConditionInput) {
  return {
    kind: 'llm' as const,
    text: condition.text,
    source: condition.source,
  };
}

function outcomeFor(
  condition: PlanConditionInput,
  state: ConditionState,
  evidenceIds: readonly string[],
  notes: readonly string[],
): ConditionOutcome {
  return {
    conditionId: condition.id,
    requirementId: condition.requirementId,
    interpretation: interpretationOf(condition),
    state,
    evidenceIds,
    notes,
  };
}

export function deriveConditionOutcomes(
  runPlan: RunPlanInput,
  evidence: readonly Evidence[],
): ConditionOutcome[] {
  return runPlan.conditions.map((condition) => {
    const conditionEvidence = evidence.filter((item) =>
      item.conditionIds.includes(condition.id),
    );
    const evidenceIds = conditionEvidence.map((item) => item.id);
    if (condition.ambiguity !== null) {
      return outcomeFor(condition, 'ambiguous', evidenceIds, [
        '要件不明確のため、実行結果があっても検証成功とはしません。',
      ]);
    }

    const failed = conditionEvidence.some(
      (item) => item.status === 'assertion-failed',
    );
    if (failed) {
      return outcomeFor(condition, 'failed', evidenceIds, [
        '実行したテストが失敗しました。',
      ]);
    }

    const generated = conditionEvidence.filter(
      (item) => item.kind === 'generated',
    );
    const passedGenerated = generated.some((item) => item.status === 'passed');
    if (passedGenerated) {
      return outcomeFor(condition, 'verified', evidenceIds, [
        '生成テストが成功しました。要件全体の正しさを証明しません。',
      ]);
    }

    const impossible = conditionEvidence.find(
      (item) =>
        item.status === 'runner-startup-failed' ||
        item.status === 'environment-insufficient' ||
        item.status === 'timeout',
    );
    if (impossible) {
      return outcomeFor(condition, 'execution-impossible', evidenceIds, [
        '実行環境または起動の失敗により判定できません。',
      ]);
    }

    const invalid = conditionEvidence.find(
      (item) => item.status === 'invalid-generated-test',
    );
    if (invalid) {
      return outcomeFor(condition, 'unverified', evidenceIds, [
        '生成テストが実行可能なテストになっていません。製品不具合の証拠として扱いません。',
      ]);
    }

    const existingPassed = conditionEvidence.some(
      (item) => item.kind === 'existing' && item.status === 'passed',
    );
    if (existingPassed) {
      return outcomeFor(condition, 'unverified', evidenceIds, [
        '既存テスト候補は成功しましたが、条件を十分に確認したとは限りません。',
      ]);
    }

    return outcomeFor(condition, 'unverified', evidenceIds, [
      'この条件に対応する実行証拠がありません。',
    ]);
  });
}

function emptyStateCounts(): Record<ConditionState, number> {
  return {
    verified: 0,
    failed: 0,
    unverified: 0,
    ambiguous: 0,
    'execution-impossible': 0,
  };
}

function worstState(states: readonly ConditionState[]): ConditionState {
  return states.reduce<ConditionState>(
    (worst, state) =>
      statePriority[state] < statePriority[worst] ? state : worst,
    'verified',
  );
}

export function summarizeRequirements(
  conditions: readonly PlanConditionInput[],
  outcomes: readonly ConditionOutcome[],
): RequirementOutcome[] {
  const outcomeById = new Map(
    outcomes.map((outcome) => [outcome.conditionId, outcome]),
  );
  const groups = new Map<
    string,
    {
      readonly conditions: PlanConditionInput[];
      readonly outcomes: ConditionOutcome[];
    }
  >();
  for (const condition of conditions) {
    const outcome = outcomeById.get(condition.id) ?? {
      conditionId: condition.id,
      requirementId: condition.requirementId,
      interpretation: interpretationOf(condition),
      state: 'unverified' as const,
      evidenceIds: [],
      notes: ['この条件に対応する実行証拠がありません。'],
    };
    const current = groups.get(condition.requirementId);
    if (current) {
      current.conditions.push(condition);
      current.outcomes.push(outcome);
    } else {
      groups.set(condition.requirementId, {
        conditions: [condition],
        outcomes: [outcome],
      });
    }
  }

  return [...groups.values()].map((group) => {
    const first = group.conditions[0]!;
    const conditionStateSummaries: ConditionStateSummary[] = group.outcomes.map(
      (outcome) => ({
        conditionId: outcome.conditionId,
        state: outcome.state,
        evidenceIds: outcome.evidenceIds,
      }),
    );
    const stateCounts = emptyStateCounts();
    for (const conditionState of conditionStateSummaries) {
      stateCounts[conditionState.state] += 1;
    }
    const state = worstState(conditionStateSummaries.map((item) => item.state));
    const notes: string[] = [];
    if (state === 'verified') {
      notes.push(
        '要件に含まれる全ての条件で生成テストが成功しました。要件全体の正しさを証明しません。',
      );
    } else {
      notes.push(
        '検証成功以外の条件を含むため、要件全体を検証成功として扱いません。',
      );
      const nonVerifiedStates = [
        ...new Set(
          conditionStateSummaries
            .map((item) => item.state)
            .filter((state) => state !== 'verified'),
        ),
      ];
      for (const currentState of nonVerifiedStates) {
        notes.push(
          `${conditionStateLabels[currentState]}: ${conditionStateSummaries
            .filter((item) => item.state === currentState)
            .map((item) => item.conditionId)
            .join(', ')}`,
        );
      }
    }
    return {
      requirementId: first.requirementId,
      interpretation: {
        kind: 'llm' as const,
        text: first.requirementText,
        source: first.requirementSource,
        origin: first.requirementOrigin,
      },
      state,
      aggregation: 'worst-condition-state' as const,
      conditionStates: conditionStateSummaries,
      stateCounts,
      notes,
    };
  });
}
