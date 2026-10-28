import type { PlanningCli } from '../plan/llm.js';
import type {
  ChangedFile,
  ExcludedFile,
  Reproducibility,
  VerificationInputSnapshot,
} from '../verify/types.js';
import type {
  ExecutionSettings,
  MissingScenario,
  RequirementOrigin,
  RequirementPlan,
  SourceReference,
  SourceFileIdentity,
} from '../plan/types.js';

export interface RunOptions {
  readonly plan: string;
  readonly profile?: string;
  readonly json: boolean;
}

export interface RunEnvironment {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly invokeCli?: PlanningCli;
}

export interface PlanConditionInput {
  readonly id: string;
  readonly requirementId: string;
  readonly requirementText: string;
  readonly requirementSource: SourceReference;
  readonly requirementOrigin: RequirementOrigin;
  readonly text: string;
  readonly source: SourceReference;
  readonly ambiguity: string | null;
  readonly missingScenarios: readonly MissingScenario[];
}

export interface RunPlanInput {
  readonly plan: RequirementPlan;
  readonly conditions: readonly PlanConditionInput[];
  readonly path: string;
}

export interface GeneratedTest {
  readonly conditionId: string;
  readonly name: string;
  readonly rationale: string;
  readonly code: string;
  readonly file: string;
  readonly digest: string;
}

export type EvidenceStatus =
  | 'passed'
  | 'assertion-failed'
  | 'invalid-generated-test'
  | 'runner-startup-failed'
  | 'environment-insufficient'
  | 'timeout'
  | 'skipped';

export type TestKind = 'existing' | 'generated';

export interface Evidence {
  readonly id: string;
  readonly kind: TestKind;
  readonly conditionIds: readonly string[];
  readonly testName: string;
  readonly file: string;
  readonly content: string | null;
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly status: EvidenceStatus;
  readonly log: string;
  readonly logTruncated: boolean;
}

export type ConditionState =
  'verified' | 'failed' | 'unverified' | 'ambiguous' | 'execution-impossible';

export interface ConditionInterpretation {
  readonly kind: 'llm';
  readonly text: string;
  readonly source: SourceReference;
}

export interface ConditionOutcome {
  readonly conditionId: string;
  readonly requirementId: string;
  readonly interpretation: ConditionInterpretation;
  readonly state: ConditionState;
  readonly evidenceIds: readonly string[];
  readonly notes: readonly string[];
}

export interface ConditionStateSummary {
  readonly conditionId: string;
  readonly state: ConditionState;
  readonly evidenceIds: readonly string[];
}

export interface RequirementOutcome {
  readonly requirementId: string;
  readonly interpretation: {
    readonly kind: 'llm';
    readonly text: string;
    readonly source: SourceReference;
    readonly origin: RequirementOrigin;
  };
  readonly state: ConditionState;
  readonly aggregation: 'worst-condition-state';
  readonly conditionStates: readonly ConditionStateSummary[];
  readonly stateCounts: Readonly<Record<ConditionState, number>>;
  readonly notes: readonly string[];
}

export interface IsolationReport {
  readonly mode: 'process';
  readonly root: string;
  readonly network: 'blocked';
  readonly credentials: 'not-forwarded';
  readonly dependencyMode: ExecutionSettings['dependencies']['mode'];
  readonly runner: string;
  readonly copiedFiles: number;
  readonly excluded: readonly string[];
  readonly limits: {
    readonly timeoutMs: number | null;
    readonly maxMemoryMb: number | null;
    readonly maxOutputBytes: number | null;
  };
  readonly cleanup: {
    readonly status: 'removed' | 'failed';
    readonly note: string;
  };
}

export interface RunReportInput {
  readonly sourceFiles?: readonly SourceFileIdentity[];
  readonly repository: string;
  readonly head: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly mergeBase: string;
  readonly snapshotDigest: string;
  readonly planPath: string;
  readonly planDigest: string;
  readonly diff: {
    readonly digest: string;
    readonly files: readonly ChangedFile[];
    readonly excluded: readonly ExcludedFile[];
    readonly untracked: readonly string[];
    readonly kinds: {
      readonly committed: number;
      readonly uncommitted: number;
      readonly untracked: number;
    };
  };
  readonly issue: {
    readonly input: 'issue-file' | 'none';
    readonly path: string | null;
    readonly title: string | null;
    readonly state: string | null;
    readonly source: string | null;
    readonly digest: string | null;
  };
  readonly reproducibility: Reproducibility;
}

export interface RunReport {
  readonly schemaVersion: '1';
  readonly phase: 'isolated-execution';
  readonly verification: 'completed' | 'partial';
  readonly input: RunReportInput;
  readonly generation: {
    readonly provider: string;
    readonly model: string;
    readonly requestCount: number;
    readonly maxRequests: number | null;
    readonly repairAttempts: number;
    readonly maxRepairAttempts: number;
    readonly requestedConditions: number;
    readonly generatedFiles: number;
  };
  readonly isolation: IsolationReport;
  readonly requirements: readonly RequirementOutcome[];
  readonly conditions: readonly ConditionOutcome[];
  readonly evidence: readonly Evidence[];
  readonly unverified: readonly string[];
  readonly warnings: readonly string[];
  readonly partialReasons: readonly string[];
  readonly rerunCommand: string;
  readonly disclaimer: string;
  readonly digest: string;
}

export interface IsolationWorkspace {
  readonly root: string;
  readonly workDir: string;
  readonly runnerPath: string;
  readonly runnerNodeModules: string;
  readonly copiedFiles: number;
  readonly excluded: string[];
  readonly dependencyMode: ExecutionSettings['dependencies']['mode'];
  cleanup(): { status: 'removed' | 'failed'; note: string };
}

export interface ExecuteSuiteOptions {
  readonly workspace: IsolationWorkspace;
  readonly settings: ExecutionSettings;
  readonly include: readonly string[];
  readonly name: string;
  readonly kind: TestKind;
  readonly conditionIdsByTest?: (file: string, name: string) => string[];
}

export interface SuiteResult {
  readonly evidence: readonly Evidence[];
  readonly status: EvidenceStatus;
  readonly setupFailure: boolean;
}

export type { VerificationInputSnapshot };
