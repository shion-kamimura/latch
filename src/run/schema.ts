import { RequirementPlanError } from '../plan/errors.js';
import { conditionStates, RUN_REPORT_SCHEMA_VERSION } from './report.js';
import type { ConditionState, EvidenceStatus, RunReport } from './types.js';

const verificationStates = ['completed', 'partial'] as const;
const evidenceStatuses: readonly EvidenceStatus[] = [
  'passed',
  'assertion-failed',
  'invalid-generated-test',
  'runner-startup-failed',
  'environment-insufficient',
  'timeout',
  'skipped',
];
const evidenceKinds = ['existing', 'generated'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isState(value: unknown): value is ConditionState {
  return (
    typeof value === 'string' &&
    conditionStates.includes(value as ConditionState)
  );
}

function checkInterpretation(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} がオブジェクトではありません。`);
    return;
  }
  if (value.kind !== 'llm') errors.push(`${path}.kind が llm ではありません。`);
  if (!isString(value.text))
    errors.push(`${path}.text が文字列ではありません。`);
  if (!isRecord(value.source)) {
    errors.push(`${path}.source がオブジェクトではありません。`);
  }
}

function checkStateCounts(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} がオブジェクトではありません。`);
    return;
  }
  for (const state of conditionStates) {
    if (typeof value[state] !== 'number') {
      errors.push(`${path}.${state} が数値ではありません。`);
    }
  }
}

function checkInput(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('input がオブジェクトではありません。');
    return;
  }
  for (const field of [
    'repository',
    'head',
    'baseRef',
    'baseCommit',
    'mergeBase',
    'snapshotDigest',
    'planPath',
    'planDigest',
  ]) {
    if (!isString(value[field])) {
      errors.push(`input.${field} が文字列ではありません。`);
    }
  }
  if (!isRecord(value.diff)) {
    errors.push('input.diff がオブジェクトではありません。');
  } else {
    if (!isString(value.diff.digest)) {
      errors.push('input.diff.digest が文字列ではありません。');
    }
    if (!Array.isArray(value.diff.files)) {
      errors.push('input.diff.files が配列ではありません。');
    }
    if (!Array.isArray(value.diff.excluded)) {
      errors.push('input.diff.excluded が配列ではありません。');
    }
    if (!isStringArray(value.diff.untracked)) {
      errors.push('input.diff.untracked が文字列配列ではありません。');
    }
    if (!isRecord(value.diff.kinds)) {
      errors.push('input.diff.kinds がオブジェクトではありません。');
    } else {
      for (const kind of ['committed', 'uncommitted', 'untracked']) {
        if (typeof value.diff.kinds[kind] !== 'number') {
          errors.push(`input.diff.kinds.${kind} が数値ではありません。`);
        }
      }
    }
  }
  if (!isRecord(value.issue)) {
    errors.push('input.issue がオブジェクトではありません。');
  } else if (
    value.issue.input !== 'issue-file' &&
    value.issue.input !== 'none'
  ) {
    errors.push('input.issue.input が issue-file または none ではありません。');
  } else if (value.issue.input === 'issue-file') {
    for (const field of ['path', 'title', 'state', 'source', 'digest']) {
      if (!isString(value.issue[field])) {
        errors.push(`input.issue.${field} が文字列ではありません。`);
      }
    }
  }
  if (!isRecord(value.reproducibility)) {
    errors.push('input.reproducibility がオブジェクトではありません。');
  } else {
    if (typeof value.reproducibility.ciReproducible !== 'boolean') {
      errors.push(
        'input.reproducibility.ciReproducible が真偽値ではありません。',
      );
    }
    if (!isStringArray(value.reproducibility.notes)) {
      errors.push('input.reproducibility.notes が文字列配列ではありません。');
    }
  }
}

function checkRequirements(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('requirements が配列ではありません。');
    return;
  }
  for (const [index, requirement] of value.entries()) {
    const path = `requirements[${index}]`;
    if (!isRecord(requirement)) {
      errors.push(`${path} がオブジェクトではありません。`);
      continue;
    }
    if (!isString(requirement.requirementId)) {
      errors.push(`${path}.requirementId が文字列ではありません。`);
    }
    checkInterpretation(
      requirement.interpretation,
      `${path}.interpretation`,
      errors,
    );
    if (!isState(requirement.state)) {
      errors.push(`${path}.state が不正です。`);
    }
    if (requirement.aggregation !== 'worst-condition-state') {
      errors.push(`${path}.aggregation が不正です。`);
    }
    if (!Array.isArray(requirement.conditionStates)) {
      errors.push(`${path}.conditionStates が配列ではありません。`);
    } else {
      for (const [
        conditionIndex,
        conditionState,
      ] of requirement.conditionStates.entries()) {
        const conditionPath = `${path}.conditionStates[${conditionIndex}]`;
        if (!isRecord(conditionState)) {
          errors.push(`${conditionPath} がオブジェクトではありません。`);
          continue;
        }
        if (!isString(conditionState.conditionId)) {
          errors.push(`${conditionPath}.conditionId が文字列ではありません。`);
        }
        if (!isState(conditionState.state)) {
          errors.push(`${conditionPath}.state が不正です。`);
        }
        if (!isStringArray(conditionState.evidenceIds)) {
          errors.push(
            `${conditionPath}.evidenceIds が文字列配列ではありません。`,
          );
        }
      }
    }
    checkStateCounts(requirement.stateCounts, `${path}.stateCounts`, errors);
    if (!isStringArray(requirement.notes)) {
      errors.push(`${path}.notes が文字列配列ではありません。`);
    }
  }
}

function checkConditions(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('conditions が配列ではありません。');
    return;
  }
  const ids = new Set<string>();
  for (const [index, condition] of value.entries()) {
    const path = `conditions[${index}]`;
    if (!isRecord(condition)) {
      errors.push(`${path} がオブジェクトではありません。`);
      continue;
    }
    if (!isString(condition.conditionId)) {
      errors.push(`${path}.conditionId が文字列ではありません。`);
    } else if (ids.has(condition.conditionId)) {
      errors.push(`${path}.conditionId が重複しています。`);
    } else {
      ids.add(condition.conditionId);
    }
    if (!isString(condition.requirementId)) {
      errors.push(`${path}.requirementId が文字列ではありません。`);
    }
    checkInterpretation(
      condition.interpretation,
      `${path}.interpretation`,
      errors,
    );
    if (!isState(condition.state)) {
      errors.push(`${path}.state が不正です。`);
    }
    if (!isStringArray(condition.evidenceIds)) {
      errors.push(`${path}.evidenceIds が文字列配列ではありません。`);
    }
    if (!isStringArray(condition.notes)) {
      errors.push(`${path}.notes が文字列配列ではありません。`);
    }
  }
}

function checkEvidence(
  value: unknown,
  conditionIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push('evidence が配列ではありません。');
    return;
  }
  const ids = new Set<string>();
  for (const [index, evidence] of value.entries()) {
    const path = `evidence[${index}]`;
    if (!isRecord(evidence)) {
      errors.push(`${path} がオブジェクトではありません。`);
      continue;
    }
    if (!isString(evidence.id)) {
      errors.push(`${path}.id が文字列ではありません。`);
    } else if (ids.has(evidence.id)) {
      errors.push(`${path}.id が重複しています。`);
    } else {
      ids.add(evidence.id);
    }
    if (
      typeof evidence.kind !== 'string' ||
      !evidenceKinds.includes(evidence.kind as (typeof evidenceKinds)[number])
    ) {
      errors.push(`${path}.kind が不正です。`);
    }
    if (
      typeof evidence.status !== 'string' ||
      !evidenceStatuses.includes(evidence.status as EvidenceStatus)
    ) {
      errors.push(`${path}.status が不正です。`);
    }
    for (const field of ['testName', 'file', 'command', 'log']) {
      if (!isString(evidence[field])) {
        errors.push(`${path}.${field} が文字列ではありません。`);
      }
    }
    if (evidence.exitCode !== null && typeof evidence.exitCode !== 'number') {
      errors.push(`${path}.exitCode が数値または null ではありません。`);
    }
    if (evidence.signal !== null && typeof evidence.signal !== 'string') {
      errors.push(`${path}.signal が文字列または null ではありません。`);
    }
    if (typeof evidence.durationMs !== 'number') {
      errors.push(`${path}.durationMs が数値ではありません。`);
    }
    if (evidence.content !== null && typeof evidence.content !== 'string') {
      errors.push(`${path}.content が文字列または null ではありません。`);
    }
    if (typeof evidence.logTruncated !== 'boolean') {
      errors.push(`${path}.logTruncated が真偽値ではありません。`);
    }
    if (!isStringArray(evidence.conditionIds)) {
      errors.push(`${path}.conditionIds が文字列配列ではありません。`);
    } else {
      for (const conditionId of evidence.conditionIds) {
        if (!conditionIds.has(conditionId)) {
          errors.push(
            `${path}.conditionIds の ${conditionId} が conditions にありません。`,
          );
        }
      }
    }
  }
}

function checkReferences(
  value: Record<string, unknown>,
  errors: string[],
): void {
  const conditionIds = new Set(
    (Array.isArray(value.conditions) ? value.conditions : [])
      .filter(isRecord)
      .map((condition) => condition.conditionId)
      .filter(isString),
  );
  const evidenceIds = new Set(
    (Array.isArray(value.evidence) ? value.evidence : [])
      .filter(isRecord)
      .map((evidence) => evidence.id)
      .filter(isString),
  );
  for (const condition of Array.isArray(value.conditions)
    ? value.conditions
    : []) {
    if (!isRecord(condition) || !Array.isArray(condition.evidenceIds)) continue;
    for (const evidenceId of condition.evidenceIds) {
      if (isString(evidenceId) && !evidenceIds.has(evidenceId)) {
        errors.push(
          `conditions の ${String(condition.conditionId)} が参照する証拠 ${evidenceId} がありません。`,
        );
      }
    }
  }
  for (const requirement of Array.isArray(value.requirements)
    ? value.requirements
    : []) {
    if (!isRecord(requirement) || !Array.isArray(requirement.conditionStates)) {
      continue;
    }
    for (const conditionState of requirement.conditionStates) {
      if (
        isRecord(conditionState) &&
        isString(conditionState.conditionId) &&
        !conditionIds.has(conditionState.conditionId)
      ) {
        errors.push(
          `requirements が参照する条件 ${conditionState.conditionId} がありません。`,
        );
      }
    }
  }
}

export function validateRunReport(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ['レポートがオブジェクトではありません。'];
  }
  if (value.schemaVersion !== RUN_REPORT_SCHEMA_VERSION) {
    errors.push('schemaVersion が対応していません。');
  }
  if (value.phase !== 'isolated-execution') {
    errors.push('phase が isolated-execution ではありません。');
  }
  if (
    typeof value.verification !== 'string' ||
    !verificationStates.includes(
      value.verification as (typeof verificationStates)[number],
    )
  ) {
    errors.push('verification が completed または partial ではありません。');
  }
  checkInput(value.input, errors);
  checkRequirements(value.requirements, errors);
  checkConditions(value.conditions, errors);
  checkEvidence(
    value.evidence,
    new Set(
      (Array.isArray(value.conditions) ? value.conditions : [])
        .filter(isRecord)
        .map((condition) => condition.conditionId)
        .filter(isString),
    ),
    errors,
  );
  checkReferences(value, errors);
  if (!isStringArray(value.unverified)) {
    errors.push('unverified が文字列配列ではありません。');
  }
  if (!isStringArray(value.warnings)) {
    errors.push('warnings が文字列配列ではありません。');
  }
  if (!isStringArray(value.partialReasons)) {
    errors.push('partialReasons が文字列配列ではありません。');
  }
  if (!isString(value.rerunCommand)) {
    errors.push('rerunCommand が文字列ではありません。');
  }
  if (!isString(value.disclaimer)) {
    errors.push('disclaimer が文字列ではありません。');
  }
  if (!isString(value.digest)) {
    errors.push('digest が文字列ではありません。');
  }
  if (
    value.verification === 'partial' &&
    (!Array.isArray(value.partialReasons) || value.partialReasons.length === 0)
  ) {
    errors.push('partial レポートに partialReasons がありません。');
  }
  if (
    value.verification === 'completed' &&
    Array.isArray(value.partialReasons) &&
    value.partialReasons.length > 0
  ) {
    errors.push('completed レポートに partialReasons があります。');
  }
  return errors;
}

export function assertValidRunReport(
  value: unknown,
): asserts value is RunReport {
  const errors = validateRunReport(value);
  if (errors.length > 0) {
    throw new RequirementPlanError(
      `検証レポートの形式が不正です: ${errors[0]}`,
      '書きかけのレポートを出力せずに停止しました。同じ入力で再実行してください。',
      2,
    );
  }
}
