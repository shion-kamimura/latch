import type { PlanningCli } from './llm.js';
import type {
  ChangedFile,
  ExcludedFile,
  VerificationInputSnapshot,
} from '../verify/types.js';

export type DataCategory = 'issue' | 'diff' | 'tests' | 'source';

export interface SourceFileIdentity {
  readonly path: string;
  readonly digest: string;
}

export interface SourceFileInput extends SourceFileIdentity {
  readonly content: string;
}

export type RequirementOrigin = 'issue-explicit' | 'diff-inferred';

export type PlanState = 'unverified' | 'ambiguous';

export interface SourceReference {
  readonly kind: 'issue' | 'diff';
  readonly path: string;
  readonly line: number | null;
  readonly label: string;
}

export interface MissingScenario {
  readonly id: string;
  readonly conditionId: string;
  readonly description: string;
  readonly rationale: string;
  readonly state: PlanState;
  readonly evidence: 'none';
}

export interface RequirementCondition {
  readonly id: string;
  readonly requirementId: string;
  readonly text: string;
  readonly source: SourceReference;
  readonly origin: RequirementOrigin;
  readonly state: PlanState;
  readonly ambiguity: string | null;
  readonly existingTestCandidateIds: readonly string[];
  readonly missingScenarios: readonly MissingScenario[];
}

export interface ExtractedRequirement {
  readonly id: string;
  readonly text: string;
  readonly source: SourceReference;
  readonly origin: RequirementOrigin;
  readonly state: PlanState;
  readonly ambiguity: string | null;
  readonly conditions: readonly RequirementCondition[];
}

export interface ExistingTestCandidate {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly framework: 'vitest';
  readonly matchedConditionIds: readonly string[];
}

export interface PlanningLimits {
  readonly maxRequests: number | null;
  readonly timeoutMs: number | null;
  readonly maxOutputBytes: number | null;
  readonly maxInputCharacters: number | null;
}

export type DependencyPreparationMode = 'runner' | 'offline' | 'registry';

export interface ExecutionSettings {
  readonly dependencies: {
    readonly mode: DependencyPreparationMode;
    readonly registry: string | null;
  };
  readonly network: {
    readonly allowedDestinations: readonly string[];
  };
  readonly limits: {
    readonly timeoutMs: number | null;
    readonly maxMemoryMb: number | null;
    readonly maxOutputBytes: number | null;
    readonly maxGeneratedFiles: number | null;
    readonly maxGeneratedFileBytes: number | null;
    readonly maxRepairAttempts: number;
  };
}

export interface PlanningProfile {
  readonly id: string;
  readonly decision: 'allowed' | 'denied' | 'revoked';
  readonly allowed: {
    readonly provider: string;
    readonly project: string;
    readonly dataCategories: readonly DataCategory[];
    readonly sourceFiles?: readonly string[];
  };
  readonly connection: {
    readonly provider: string;
    readonly model: string;
  };
  readonly limits: PlanningLimits;
  readonly execution?: ExecutionSettings;
  readonly path: string;
}

export interface PlanningScope {
  readonly provider: string;
  readonly project: string;
  readonly dataCategories: readonly DataCategory[];
}

export interface RequirementPlan {
  readonly phase: 'requirement-planning';
  readonly verification: 'not-run';
  readonly input: {
    readonly repository: { readonly root: string; readonly head: string };
    readonly base: {
      readonly ref: string;
      readonly commit: string;
      readonly mergeBase: string;
    };
    readonly issue: {
      readonly path: string;
      readonly title: string;
      readonly state: string;
      readonly source: string;
    } | null;
    readonly diff: {
      readonly files: readonly ChangedFile[];
      readonly excluded: readonly ExcludedFile[];
      readonly digest: string;
    };
    readonly options: {
      readonly base: string | null;
      readonly issueFile: string | null;
      readonly includeUntracked: readonly string[];
    };
    readonly snapshotDigest: string;
    readonly sourceFiles?: readonly SourceFileIdentity[];
  };
  readonly permission: {
    readonly profileId: string;
    readonly profilePath: string;
    readonly provider: string;
    readonly project: string;
    readonly dataCategories: readonly DataCategory[];
  };
  readonly llm: {
    readonly provider: string;
    readonly model: string;
    readonly requestCount: number;
    readonly maxRequests: number | null;
    readonly timeoutMs: number | null;
  };
  readonly requirements: readonly ExtractedRequirement[];
  readonly testCandidates: readonly ExistingTestCandidate[];
  readonly unverified: readonly string[];
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
  readonly digest: string;
  readonly rerunCommand: string;
}

export interface PlanOptions {
  readonly base?: string;
  readonly issueFile?: string;
  readonly includeUntracked: readonly string[];
  readonly json: boolean;
  readonly profile?: string;
}

export interface PlanEnvironment {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly invokeCli?: PlanningCli;
}

export type { VerificationInputSnapshot };
