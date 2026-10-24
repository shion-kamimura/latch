export type ChangeKind = 'committed' | 'uncommitted' | 'untracked';

export type ExclusionReason =
  | 'binary'
  | 'symlink'
  | 'submodule'
  | 'git-internal'
  | 'outside-boundary'
  | 'not-utf8';

export interface ChangedFile {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly status: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface ExcludedFile {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly reason: ExclusionReason;
}

export interface UntrackedFile {
  readonly path: string;
  readonly content: string;
  readonly digest: string;
}

export interface ResolvedBase {
  readonly requested: string | null;
  readonly ref: string;
  readonly commit: string;
  readonly mergeBase: string;
  readonly usedDefault: boolean;
}

export interface IssueInput {
  readonly path: string;
  readonly title: string;
  readonly state: string;
  readonly source: string;
  readonly content: string;
  readonly digest: string;
}

export interface DiffSnapshot {
  readonly committed: string;
  readonly uncommitted: string;
  readonly untracked: readonly UntrackedFile[];
  readonly files: readonly ChangedFile[];
  readonly excluded: readonly ExcludedFile[];
  readonly digest: string;
}

export interface Reproducibility {
  readonly ciReproducible: boolean;
  readonly notes: readonly string[];
}

export interface VerificationInputSnapshot {
  readonly phase: 'input-resolution';
  readonly verification: 'not-run';
  readonly repository: {
    readonly root: string;
    readonly head: string;
  };
  readonly base: ResolvedBase;
  readonly diff: DiffSnapshot;
  readonly issue: IssueInput | null;
  readonly warnings: readonly string[];
  readonly reproducibility: Reproducibility;
  readonly digest: string;
  readonly rerunCommand: string;
}

export interface VerifyOptions {
  readonly base?: string;
  readonly issueFile?: string;
  readonly includeUntracked: readonly string[];
  readonly json: boolean;
}

export interface VerifyEnvironment {
  readonly cwd: string;
}
