import { describe, expect, test } from 'vitest';
import {
  conditionStateLabels,
  deriveConditionOutcomes,
  REPORT_DISCLAIMER,
  summarizeRequirements,
} from '../../src/run/report.js';
import { validateRunReport } from '../../src/run/schema.js';
import type {
  ConditionOutcome,
  Evidence,
  PlanConditionInput,
  RunPlanInput,
  RunReport,
} from '../../src/run/types.js';

const source = {
  kind: 'issue' as const,
  path: 'issue.md',
  line: 1,
  label: 'issue:issue.md#L1',
};

function condition(
  id: string,
  overrides: Partial<PlanConditionInput> = {},
): PlanConditionInput {
  return {
    id,
    requirementId: 'req-1',
    requirementText: 'The requirement text.',
    requirementSource: source,
    requirementOrigin: 'issue-explicit',
    text: `Condition ${id}.`,
    source,
    ambiguity: null,
    missingScenarios: [],
    ...overrides,
  };
}

function evidence(
  conditionId: string,
  status: Evidence['status'],
  kind: Evidence['kind'] = 'generated',
): Evidence {
  return {
    id: `evidence-${conditionId}-${status}`,
    kind,
    conditionIds: [conditionId],
    testName: `test ${conditionId}`,
    file: `.latch/generated/${conditionId}.test.ts`,
    content: kind === 'generated' ? 'generated test' : null,
    command: 'vitest run',
    exitCode: status === 'passed' ? 0 : 1,
    signal: null,
    durationMs: 10,
    status,
    log: 'log',
    logTruncated: false,
  };
}

function runPlan(conditions: readonly PlanConditionInput[]): RunPlanInput {
  return {
    plan: {} as RunPlanInput['plan'],
    conditions,
    path: '/tmp/plan.json',
  };
}

function reportWith(
  requirements: RunReport['requirements'],
  conditions: RunReport['conditions'],
  evidenceItems: RunReport['evidence'],
): RunReport {
  return {
    schemaVersion: '1',
    phase: 'isolated-execution',
    verification: 'completed',
    input: {
      repository: '/repo',
      head: 'head',
      baseRef: 'origin/main',
      baseCommit: 'base',
      mergeBase: 'merge-base',
      snapshotDigest: 'a'.repeat(64),
      planPath: '/tmp/plan.json',
      planDigest: 'b'.repeat(64),
      diff: {
        digest: 'c'.repeat(64),
        files: [],
        excluded: [],
        untracked: [],
        kinds: { committed: 0, uncommitted: 0, untracked: 0 },
      },
      issue: {
        input: 'none',
        path: null,
        title: null,
        state: null,
        source: null,
        digest: null,
      },
      reproducibility: { ciReproducible: true, notes: [] },
    },
    generation: {
      provider: 'openai-compatible',
      model: 'test',
      requestCount: 1,
      maxRequests: 1,
      repairAttempts: 0,
      maxRepairAttempts: 1,
      requestedConditions: 1,
      generatedFiles: 1,
    },
    isolation: {
      mode: 'process',
      root: '<temporary>',
      network: 'blocked',
      credentials: 'not-forwarded',
      dependencyMode: 'runner',
      runner: '<latch-vitest>',
      copiedFiles: 1,
      excluded: [],
      limits: { timeoutMs: 1000, maxMemoryMb: 128, maxOutputBytes: 1000 },
      cleanup: { status: 'removed', note: 'removed' },
    },
    requirements,
    conditions,
    evidence: evidenceItems,
    unverified: [],
    warnings: [],
    partialReasons: [],
    rerunCommand: 'latch run --plan /tmp/plan.json',
    disclaimer: REPORT_DISCLAIMER,
    digest: 'd'.repeat(64),
  };
}

describe('verification report states', () => {
  test('maps evidence to all five condition states without inventing success', () => {
    const conditions = [
      condition('verified'),
      condition('failed'),
      condition('unverified'),
      condition('ambiguous', { ambiguity: 'Expected value is unclear.' }),
      condition('impossible'),
    ];
    const outcomes = deriveConditionOutcomes(runPlan(conditions), [
      evidence('verified', 'passed'),
      evidence('failed', 'assertion-failed'),
      evidence('impossible', 'timeout'),
      evidence('unverified', 'passed', 'existing'),
    ]);

    expect(
      outcomes.map((outcome) => [outcome.conditionId, outcome.state]),
    ).toEqual([
      ['verified', 'verified'],
      ['failed', 'failed'],
      ['unverified', 'unverified'],
      ['ambiguous', 'ambiguous'],
      ['impossible', 'execution-impossible'],
    ]);
    expect(
      outcomes.find((outcome) => outcome.conditionId === 'verified')
        ?.interpretation.kind,
    ).toBe('llm');
    expect(
      outcomes.find((outcome) => outcome.conditionId === 'verified')
        ?.evidenceIds,
    ).toEqual(['evidence-verified-passed']);
  });

  test('does not hide unverified or failed conditions in requirement aggregation', () => {
    const conditions = [
      condition('cond-verified'),
      condition('cond-failed'),
      condition('cond-unverified'),
    ];
    const outcomes: ConditionOutcome[] = [
      {
        conditionId: 'cond-verified',
        requirementId: 'req-1',
        interpretation: {
          kind: 'llm',
          text: 'Condition cond-verified.',
          source,
        },
        state: 'verified',
        evidenceIds: ['evidence-verified'],
        notes: [],
      },
      {
        conditionId: 'cond-failed',
        requirementId: 'req-1',
        interpretation: {
          kind: 'llm',
          text: 'Condition cond-failed.',
          source,
        },
        state: 'failed',
        evidenceIds: ['evidence-failed'],
        notes: [],
      },
      {
        conditionId: 'cond-unverified',
        requirementId: 'req-1',
        interpretation: {
          kind: 'llm',
          text: 'Condition cond-unverified.',
          source,
        },
        state: 'unverified',
        evidenceIds: [],
        notes: [],
      },
    ];

    const [requirement] = summarizeRequirements(conditions, outcomes);

    expect(requirement?.state).toBe('failed');
    expect(requirement?.stateCounts).toEqual({
      verified: 1,
      failed: 1,
      unverified: 1,
      ambiguous: 0,
      'execution-impossible': 0,
    });
    expect(requirement?.conditionStates.map((item) => item.state)).toEqual([
      'verified',
      'failed',
      'unverified',
    ]);
    expect(requirement?.notes.join('\n')).toContain(
      '要件全体を検証成功として扱いません',
    );
    expect(requirement?.notes.join('\n')).toContain(
      `${conditionStateLabels.failed}: cond-failed`,
    );
    expect(requirement?.notes.join('\n')).toContain(
      `${conditionStateLabels.unverified}: cond-unverified`,
    );
  });

  test('marks a requirement verified only when every condition passed', () => {
    const conditions = [condition('a'), condition('b')];
    const outcomes = deriveConditionOutcomes(runPlan(conditions), [
      evidence('a', 'passed'),
      evidence('b', 'passed'),
    ]);

    const [requirement] = summarizeRequirements(conditions, outcomes);

    expect(requirement?.state).toBe('verified');
    expect(requirement?.stateCounts.verified).toBe(2);
  });
});

describe('verification report schema', () => {
  test('accepts a complete report and rejects incompatible or orphaned data', () => {
    const conditions = [condition('cond-verified')];
    const outcomes = deriveConditionOutcomes(runPlan(conditions), [
      evidence('cond-verified', 'passed'),
    ]);
    const requirements = summarizeRequirements(conditions, outcomes);
    const report = reportWith(requirements, outcomes, [
      evidence('cond-verified', 'passed'),
    ]);

    expect(validateRunReport(report)).toEqual([]);

    expect(validateRunReport({ ...report, schemaVersion: '2' })).toContain(
      'schemaVersion が対応していません。',
    );
    expect(
      validateRunReport({
        ...report,
        conditions: [{ ...outcomes[0], evidenceIds: ['missing-evidence'] }],
      }),
    ).toContain(
      'conditions の cond-verified が参照する証拠 missing-evidence がありません。',
    );
  });
});
