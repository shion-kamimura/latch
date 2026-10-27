import { RequirementPlanError } from './errors.js';
import type { DiscoveredTestCandidate } from './test-candidates.js';
import type {
  ExistingTestCandidate,
  ExtractedRequirement,
  MissingScenario,
  PlanState,
  RequirementCondition,
  RequirementOrigin,
  SourceReference,
} from './types.js';
import { sha256 } from '../verify/files.js';

export interface NormalizeContext {
  readonly issuePath: string | null;
  readonly issueLineCount: number;
  readonly diffPaths: ReadonlySet<string>;
  readonly testCandidates: readonly DiscoveredTestCandidate[];
}

interface RawSource {
  readonly kind: 'issue' | 'diff';
  readonly path: string;
  readonly line: number | null;
}

interface RawScenario {
  readonly description: string;
  readonly rationale: string;
}

interface RawCondition {
  readonly text: string;
  readonly source: RawSource;
  readonly origin: RequirementOrigin;
  readonly ambiguity: string | null;
  readonly existingTestCandidateIds: readonly string[];
  readonly missingScenarios: readonly RawScenario[];
}

interface RawRequirement {
  readonly text: string;
  readonly source: RawSource;
  readonly origin: RequirementOrigin;
  readonly ambiguity: string | null;
  readonly conditions: readonly RawCondition[];
}

function responseError(): never {
  throw new RequirementPlanError(
    'LLM応答が要件抽出のデータ契約に一致しませんでした。',
    '応答を無制限に再試行せず、provider・model・promptの互換性を確認してください。',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== 'string') {
    responseError();
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.includes('\u0000')) {
    responseError();
  }
  return normalized;
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') responseError();
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) responseError();
  return value.map((entry) => text(entry));
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    responseError();
  }
  return value;
}

function origin(value: unknown): RequirementOrigin {
  if (value === 'issue-explicit' || value === 'diff-inferred') return value;
  responseError();
}

function rawSource(value: unknown, context: NormalizeContext): RawSource {
  if (!isRecord(value)) responseError();
  if (value.kind === 'issue') {
    if (context.issuePath === null) responseError();
    const line = value.line;
    if (
      typeof line !== 'number' ||
      !Number.isInteger(line) ||
      line < 1 ||
      line > context.issueLineCount
    ) {
      responseError();
    }
    return { kind: 'issue', path: context.issuePath, line };
  }
  if (value.kind === 'diff') {
    const path = value.path;
    if (typeof path !== 'string' || !context.diffPaths.has(path)) {
      responseError();
    }
    return { kind: 'diff', path, line: null };
  }
  responseError();
}

function sourceRef(source: RawSource): SourceReference {
  const label =
    source.kind === 'issue'
      ? `issue:${source.path}#L${source.line ?? 1}`
      : `diff:${source.path}`;
  return {
    kind: source.kind,
    path: source.path,
    line: source.line,
    label,
  };
}

function checkOrigin(source: RawSource, value: RequirementOrigin): void {
  if (value === 'issue-explicit' && source.kind !== 'issue') responseError();
  if (value === 'diff-inferred' && source.kind !== 'diff') responseError();
}

function scenario(value: unknown): RawScenario {
  if (!isRecord(value)) responseError();
  return {
    description: text(value.description),
    rationale: optionalText(value.rationale) ?? '',
  };
}

function condition(value: unknown, context: NormalizeContext): RawCondition {
  if (!isRecord(value)) responseError();
  const source = rawSource(value.source, context);
  const conditionOrigin = origin(
    value.origin ??
      (source.kind === 'issue' ? 'issue-explicit' : 'diff-inferred'),
  );
  checkOrigin(source, conditionOrigin);
  const candidateIds = stringArray(value.existingTestCandidateIds);
  for (const id of candidateIds) {
    if (!context.testCandidates.some((candidate) => candidate.id === id)) {
      responseError();
    }
  }
  const rawScenarios = value.missingScenarios;
  if (rawScenarios !== undefined && !Array.isArray(rawScenarios)) {
    responseError();
  }
  const scenarios = rawScenarios ?? [];
  return {
    text: text(value.text),
    source,
    origin: conditionOrigin,
    ambiguity: optionalText(value.ambiguity),
    existingTestCandidateIds: [...new Set(candidateIds)],
    missingScenarios: scenarios.map(scenario),
  };
}

function requirement(
  value: unknown,
  context: NormalizeContext,
): RawRequirement {
  if (!isRecord(value)) responseError();
  const source = rawSource(value.source, context);
  const requirementOrigin = origin(value.origin);
  checkOrigin(source, requirementOrigin);
  return {
    text: text(value.text),
    source,
    origin: requirementOrigin,
    ambiguity: optionalText(value.ambiguity),
    conditions: array(value.conditions).map((entry) =>
      condition(entry, context),
    ),
  };
}

export function normalizeLlmResponse(
  content: string,
  context: NormalizeContext,
): {
  readonly requirements: readonly ExtractedRequirement[];
  readonly testCandidates: readonly ExistingTestCandidate[];
  readonly unverified: readonly string[];
  readonly notes: readonly string[];
} {
  const raw = parseJson(content);
  if (!isRecord(raw)) responseError();
  const rawRequirements = array(raw.requirements).map((entry) =>
    requirement(entry, context),
  );
  const unverified = stringArray(raw.unverified);
  const notes = stringArray(raw.notes);

  const usedIds = new Set<string>();
  const matched = new Map<string, string[]>();

  const requirements = rawRequirements.map((entry) => {
    const source = sourceRef(entry.source);
    const requirementId = uniqueId(
      'req',
      [entry.origin, source.label, entry.text],
      usedIds,
    );
    const state: PlanState = entry.ambiguity ? 'ambiguous' : 'unverified';
    const conditions = entry.conditions.map((conditionEntry) => {
      const conditionSource = sourceRef(conditionEntry.source);
      const conditionId = uniqueId(
        'cond',
        [
          requirementId,
          conditionEntry.origin,
          conditionSource.label,
          conditionEntry.text,
        ],
        usedIds,
      );
      const conditionState: PlanState = conditionEntry.ambiguity
        ? 'ambiguous'
        : 'unverified';
      for (const id of conditionEntry.existingTestCandidateIds) {
        const ids = matched.get(id) ?? [];
        ids.push(conditionId);
        matched.set(id, ids);
      }
      const missingScenarios = conditionEntry.missingScenarios.map(
        (scenarioEntry): MissingScenario => ({
          id: uniqueId(
            'scenario',
            [conditionId, scenarioEntry.description],
            usedIds,
          ),
          conditionId,
          description: scenarioEntry.description,
          rationale: scenarioEntry.rationale,
          state: conditionState,
          evidence: 'none',
        }),
      );
      const normalizedCondition: RequirementCondition = {
        id: conditionId,
        requirementId,
        text: conditionEntry.text,
        source: conditionSource,
        origin: conditionEntry.origin,
        state: conditionState,
        ambiguity: conditionEntry.ambiguity,
        existingTestCandidateIds: conditionEntry.existingTestCandidateIds,
        missingScenarios,
      };
      return normalizedCondition;
    });
    return {
      id: requirementId,
      text: entry.text,
      source,
      origin: entry.origin,
      state:
        state === 'ambiguous' ||
        conditions.some((item) => item.state === 'ambiguous')
          ? ('ambiguous' as const)
          : ('unverified' as const),
      ambiguity: entry.ambiguity,
      conditions,
    };
  });

  const testCandidates = context.testCandidates.map((candidate) => ({
    id: candidate.id,
    path: candidate.path,
    name: candidate.name,
    framework: candidate.framework,
    matchedConditionIds: [...new Set(matched.get(candidate.id) ?? [])].sort(),
  }));

  return { requirements, testCandidates, unverified, notes };
}

function uniqueId(
  prefix: string,
  parts: readonly string[],
  used: Set<string>,
): string {
  const base = `${prefix}-${sha256(parts.join('\u0000')).slice(0, 10)}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function parseJson(content: string): unknown {
  let value = content.trim();
  if (value.startsWith('```')) {
    const firstLineEnd = value.indexOf('\n');
    if (firstLineEnd < 0) responseError();
    value = value.slice(firstLineEnd + 1);
    const closing = value.lastIndexOf('```');
    if (closing >= 0) value = value.slice(0, closing);
    value = value.trim();
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start < 0 || end <= start) responseError();
    try {
      return JSON.parse(value.slice(start, end + 1)) as unknown;
    } catch {
      responseError();
    }
  }
}
