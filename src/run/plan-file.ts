import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { RequirementPlanError } from '../plan/errors.js';
import type {
  MissingScenario,
  RequirementPlan,
  SourceReference,
} from '../plan/types.js';
import type { PlanConditionInput, RunPlanInput } from './types.js';

const MAX_PLAN_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 4_000;

function planError(message: string, guidance: string): never {
  throw new RequirementPlanError(message, guidance);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    planError(
      `計画ファイルの ${field} が不正です。`,
      'latch plan --json の出力をそのまま保存して --plan に指定してください。',
    );
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sourceOf(value: unknown): SourceReference {
  if (!isRecord(value)) {
    planError(
      '計画ファイルの条件に出典がありません。',
      'latch plan --json の出力をそのまま保存して --plan に指定してください。',
    );
  }
  return {
    kind: value.kind === 'issue' ? 'issue' : 'diff',
    path: stringValue(value.path, 'source.path'),
    line: typeof value.line === 'number' ? value.line : null,
    label: stringValue(value.label, 'source.label'),
  };
}

function scenariosOf(value: unknown): MissingScenario[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!isRecord(entry)) {
      planError(
        '計画ファイルの不足シナリオが不正です。',
        'latch plan --json の出力をそのまま保存して --plan に指定してください。',
      );
    }
    return {
      id: stringValue(entry.id, 'missingScenarios.id'),
      conditionId: stringValue(
        entry.conditionId,
        'missingScenarios.conditionId',
      ),
      description: stringValue(
        entry.description,
        'missingScenarios.description',
      ).slice(0, MAX_TEXT),
      rationale:
        typeof entry.rationale === 'string'
          ? entry.rationale.slice(0, MAX_TEXT)
          : '',
      state: entry.state === 'ambiguous' ? 'ambiguous' : 'unverified',
      evidence: 'none',
    };
  });
}

export function readRunPlan(path: string, cwd: string): RunPlanInput {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    planError(
      '計画ファイルが見つかりませんでした。',
      'latch plan --json の出力を保存し、--plan <path> に指定してください。',
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    planError(
      '計画ファイルは通常ファイルではありません。',
      'latch plan --json の出力を通常ファイルへ保存してください。',
    );
  }
  if (stats.size > MAX_PLAN_BYTES) {
    planError(
      '計画ファイルが大きすぎます。',
      '必要な範囲の計画JSONを --plan に指定してください。',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    planError(
      '計画ファイルをJSONとして解釈できませんでした。',
      'latch plan --json の出力をそのまま保存してください。',
    );
  }
  if (!isRecord(parsed)) {
    planError(
      '計画ファイルがオブジェクトではありません。',
      'latch plan --json の出力をそのまま保存してください。',
    );
  }
  if (
    parsed.phase !== 'requirement-planning' ||
    parsed.verification !== 'not-run'
  ) {
    planError(
      '計画ファイルが要件抽出・計画の形式ではありません。',
      'latch plan --json の出力を --plan に指定してください。',
    );
  }

  const input = parsed.input;
  if (!isRecord(input)) {
    planError(
      '計画ファイルに入力情報がありません。',
      'latch plan --json の出力をそのまま保存してください。',
    );
  }
  const repository = input.repository;
  const base = input.base;
  if (!isRecord(repository) || !isRecord(base)) {
    planError(
      '計画ファイルの入力情報が不正です。',
      'latch plan --json の出力をそのまま保存してください。',
    );
  }
  stringValue(repository.root, 'input.repository.root');
  stringValue(base.ref, 'input.base.ref');
  const snapshotDigest = stringValue(
    input.snapshotDigest,
    'input.snapshotDigest',
  );
  if (!/^[0-9a-f]{64}$/u.test(snapshotDigest)) {
    planError(
      '計画ファイルのスナップショットIDが不正です。',
      'latch plan --json の出力をそのまま保存してください。',
    );
  }

  if (input.options !== undefined) {
    if (!isRecord(input.options)) {
      planError(
        '計画ファイルの入力オプションが不正です。',
        'latch plan --json の出力をそのまま保存してください。',
      );
    }
    const option = input.options;
    if (option.base !== null && typeof option.base !== 'string') {
      planError(
        '計画ファイルのbase指定が不正です。',
        'latch plan --json の出力をそのまま保存してください。',
      );
    }
    if (option.issueFile !== null && typeof option.issueFile !== 'string') {
      planError(
        '計画ファイルのIssue指定が不正です。',
        'latch plan --json の出力をそのまま保存してください。',
      );
    }
    if (
      option.includeUntracked !== undefined &&
      (!Array.isArray(option.includeUntracked) ||
        option.includeUntracked.some((entry) => typeof entry !== 'string'))
    ) {
      planError(
        '計画ファイルの未追跡ファイル指定が不正です。',
        'latch plan --json の出力をそのまま保存してください。',
      );
    }
  }

  const requirements = parsed.requirements;
  if (!Array.isArray(requirements)) {
    planError(
      '計画ファイルに要件がありません。',
      'latch plan --json の出力をそのまま保存してください。',
    );
  }

  const conditions: PlanConditionInput[] = [];
  const ids = new Set<string>();
  for (const rawRequirement of requirements) {
    if (!isRecord(rawRequirement)) {
      planError(
        '計画ファイルの要件が不正です。',
        'latch plan --json の出力をそのまま保存してください。',
      );
    }
    const requirementId = stringValue(rawRequirement.id, 'requirements.id');
    if (ids.has(requirementId)) {
      planError(
        '計画ファイルでIDが重複しています。',
        '計画JSONを手で書き換えず、latch plan を再実行してください。',
      );
    }
    ids.add(requirementId);
    const requirementText = stringValue(
      rawRequirement.text,
      'requirements.text',
    ).slice(0, MAX_TEXT);
    const rawConditions = rawRequirement.conditions;
    if (!Array.isArray(rawConditions)) continue;
    for (const rawCondition of rawConditions) {
      if (!isRecord(rawCondition)) {
        planError(
          '計画ファイルの条件が不正です。',
          'latch plan --json の出力をそのまま保存してください。',
        );
      }
      const id = stringValue(rawCondition.id, 'conditions.id');
      if (ids.has(id)) {
        planError(
          '計画ファイルでIDが重複しています。',
          '計画JSONを手で書き換えず、latch plan を再実行してください。',
        );
      }
      ids.add(id);
      conditions.push({
        id,
        requirementId,
        requirementText,
        text: stringValue(rawCondition.text, 'conditions.text').slice(
          0,
          MAX_TEXT,
        ),
        source: sourceOf(rawCondition.source),
        ambiguity: optionalString(rawCondition.ambiguity),
        missingScenarios: scenariosOf(rawCondition.missingScenarios),
      });
    }
  }

  if (conditions.length === 0) {
    planError(
      '計画ファイルに検証可能な条件がありません。',
      '要件・条件を含む計画を --plan に指定してください。',
    );
  }

  return {
    plan: parsed as unknown as RequirementPlan,
    conditions,
    path: absolute,
  };
}
