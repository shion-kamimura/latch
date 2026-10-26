import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { RequirementPlanError } from './errors.js';
import type {
  DataCategory,
  DependencyPreparationMode,
  ExecutionSettings,
  PlanningLimits,
  PlanningProfile,
  PlanningScope,
} from './types.js';
import { isInside, realPathOrNull } from '../verify/paths.js';

export const SUPPORTED_PROVIDER = 'codex-cli';

const MAX_PROFILE_BYTES = 64 * 1024;
const DATA_CATEGORIES: readonly DataCategory[] = ['issue', 'diff', 'tests'];
const HARD_LIMITS: PlanningLimits = {
  maxRequests: 3,
  timeoutMs: 120_000,
  maxOutputBytes: 1_000_000,
  maxInputCharacters: 200_000,
};
const DEFAULT_LIMITS: PlanningLimits = {
  maxRequests: 2,
  timeoutMs: 30_000,
  maxOutputBytes: 200_000,
  maxInputCharacters: 60_000,
};
const CREDENTIAL_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'accesstoken',
  'access_token',
  'secret',
  'password',
  'authorization',
  'headers',
]);

function profileError(message: string, guidance: string): never {
  throw new RequirementPlanError(message, guidance);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    profileError(
      `許可profileの ${field} がオブジェクトではありません。`,
      '許可profileの形式を確認してください。',
    );
  }
  return value;
}

function requireString(value: unknown, field: string, maximum = 500): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    profileError(
      `許可profileの ${field} が空です。`,
      '許可profileの形式を確認してください。',
    );
  }
  if (value.length > maximum) {
    profileError(
      `許可profileの ${field} が長すぎます。`,
      '許可profileの形式を確認してください。',
    );
  }
  return value;
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsCredentialField(entry));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    const normalized = key.toLowerCase();
    return CREDENTIAL_KEYS.has(normalized) || containsCredentialField(entry);
  });
}

function loopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

function readDataCategories(value: unknown): DataCategory[] {
  if (!Array.isArray(value) || value.length === 0) {
    profileError(
      '許可profileのallowed.dataCategoriesが空です。',
      '送信を許可するデータ区分（issue/diff/tests）を指定してください。',
    );
  }
  const categories: DataCategory[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      !DATA_CATEGORIES.includes(entry as DataCategory)
    ) {
      profileError(
        '許可profileに未知のデータ区分があります。',
        'allowed.dataCategoriesには issue・diff・tests だけを指定してください。',
      );
    }
    if (!categories.includes(entry as DataCategory)) {
      categories.push(entry as DataCategory);
    }
  }
  return categories;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function readLimits(value: unknown): PlanningLimits {
  if (value === undefined) return DEFAULT_LIMITS;
  const limits = requireRecord(value, 'limits');
  return {
    maxRequests: boundedInteger(
      limits.maxRequests,
      DEFAULT_LIMITS.maxRequests,
      1,
      HARD_LIMITS.maxRequests,
    ),
    timeoutMs: boundedInteger(
      limits.timeoutMs,
      DEFAULT_LIMITS.timeoutMs,
      1_000,
      HARD_LIMITS.timeoutMs,
    ),
    maxOutputBytes: boundedInteger(
      limits.maxOutputBytes,
      DEFAULT_LIMITS.maxOutputBytes,
      1_000,
      HARD_LIMITS.maxOutputBytes,
    ),
    maxInputCharacters: boundedInteger(
      limits.maxInputCharacters,
      DEFAULT_LIMITS.maxInputCharacters,
      1_000,
      HARD_LIMITS.maxInputCharacters,
    ),
  };
}

const DEFAULT_EXECUTION: ExecutionSettings = {
  dependencies: { mode: 'runner', registry: null },
  network: { allowedDestinations: [] },
  limits: {
    timeoutMs: 60_000,
    maxMemoryMb: 512,
    maxOutputBytes: 200_000,
    maxGeneratedFiles: 20,
    maxGeneratedFileBytes: 100_000,
    maxRepairAttempts: 1,
  },
};

export function defaultExecutionSettings(): ExecutionSettings {
  return DEFAULT_EXECUTION;
}

function readRegistry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    profileError(
      '許可profileのexecution.dependencies.registryが空です。',
      '依存取得を許可するHTTPSのregistry URLを指定してください。',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    profileError(
      '許可profileのexecution.dependencies.registryがURLとして解釈できません。',
      '依存取得を許可するHTTPSのregistry URLを指定してください。',
    );
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && loopbackHost(url.hostname))
  ) {
    profileError(
      '許可profileのregistryはHTTPS（またはloopbackのHTTP）である必要があります。',
      '平文の外部registryを指定しないでください。',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    profileError(
      '許可profileのregistryに認証情報・query・fragmentを含めないでください。',
      'registryのbase URLだけを指定してください。',
    );
  }
  return value.replace(/\/+$/u, '');
}

function readExecution(value: unknown): ExecutionSettings {
  if (value === undefined) return DEFAULT_EXECUTION;
  const execution = requireRecord(value, 'execution');
  const dependencies = requireRecord(
    execution.dependencies ?? {},
    'execution.dependencies',
  );
  const modeValue = dependencies.mode ?? 'runner';
  if (
    modeValue !== 'runner' &&
    modeValue !== 'offline' &&
    modeValue !== 'registry'
  ) {
    profileError(
      '許可profileのexecution.dependencies.modeが不正です。',
      'modeには runner・offline・registry のいずれかを指定してください。',
    );
  }
  const mode = modeValue as DependencyPreparationMode;
  const registry = readRegistry(dependencies.registry);
  if (mode === 'registry' && registry === null) {
    profileError(
      'registry方式の依存準備にはregistryの指定が必要です。',
      'execution.dependencies.registryへ許可するHTTPS registryを指定してください。',
    );
  }

  const network = requireRecord(execution.network ?? {}, 'execution.network');
  const destinationsValue = network.allowedDestinations ?? [];
  if (!Array.isArray(destinationsValue)) {
    profileError(
      '許可profileのexecution.network.allowedDestinationsが配列ではありません。',
      '許可するテスト通信の宛先を配列で指定してください。',
    );
  }
  const allowedDestinations = destinationsValue.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      profileError(
        '許可profileのexecution.network.allowedDestinationsに空の値があります。',
        '宛先URLを文字列で指定してください。',
      );
    }
    return entry.trim();
  });

  const limits = requireRecord(execution.limits ?? {}, 'execution.limits');
  return {
    dependencies: { mode, registry },
    network: { allowedDestinations },
    limits: {
      timeoutMs: boundedInteger(
        limits.timeoutMs,
        DEFAULT_EXECUTION.limits.timeoutMs,
        1_000,
        300_000,
      ),
      maxMemoryMb: boundedInteger(
        limits.maxMemoryMb,
        DEFAULT_EXECUTION.limits.maxMemoryMb,
        128,
        4_096,
      ),
      maxOutputBytes: boundedInteger(
        limits.maxOutputBytes,
        DEFAULT_EXECUTION.limits.maxOutputBytes,
        1_000,
        1_000_000,
      ),
      maxGeneratedFiles: boundedInteger(
        limits.maxGeneratedFiles,
        DEFAULT_EXECUTION.limits.maxGeneratedFiles,
        1,
        30,
      ),
      maxGeneratedFileBytes: boundedInteger(
        limits.maxGeneratedFileBytes,
        DEFAULT_EXECUTION.limits.maxGeneratedFileBytes,
        1_000,
        200_000,
      ),
      maxRepairAttempts: boundedInteger(
        limits.maxRepairAttempts,
        DEFAULT_EXECUTION.limits.maxRepairAttempts,
        0,
        2,
      ),
    },
  };
}

function readProfileFile(path: string, root: string): string {
  if (path.trim().length === 0) {
    profileError(
      '許可profileのパスが空です。',
      '--profile <path> または LATCH_PROFILE にワークツリー外のファイルを指定してください。',
    );
  }

  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (isInside(root, absolute)) {
    profileError(
      '許可profileはワークツリー内から読み込めません。',
      '利用者管理の設定（ワークツリー外）または信頼したCI入力を --profile に指定してください。',
    );
  }

  const realPath = realPathOrNull(absolute);
  if (!realPath) {
    profileError(
      '許可profileが見つかりませんでした。',
      '--profile <path> または LATCH_PROFILE に存在する許可profileを指定してください。',
    );
  }
  if (isInside(root, realPath)) {
    profileError(
      '許可profileの実体がワークツリー内にあります。',
      '利用者管理の設定（ワークツリー外）を指定してください。',
    );
  }

  const stats = lstatSync(realPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    profileError(
      '許可profileは通常ファイルではありません。',
      'シンボリックリンクではない通常ファイルを指定してください。',
    );
  }
  if (stats.size > MAX_PROFILE_BYTES) {
    profileError(
      '許可profileが大きすぎます。',
      '許可profileの内容を必要な範囲に絞ってください。',
    );
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(
      readFileSync(realPath),
    );
  } catch {
    profileError(
      '許可profileをUTF-8として読み取れませんでした。',
      'UTF-8のJSONファイルを指定してください。',
    );
  }
  if (content.includes('\u0000')) {
    profileError(
      '許可profileがテキスト形式ではありません。',
      'UTF-8のJSONファイルを指定してください。',
    );
  }
  return content;
}

export function parsePlanningProfile(
  content: string,
  path: string,
): PlanningProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    profileError(
      '許可profileをJSONとして解釈できませんでした。',
      '許可profileのJSON構文を確認してください。内容は表示していません。',
    );
  }
  if (!isRecord(parsed)) {
    profileError(
      '許可profileがオブジェクトではありません。',
      '許可profileの形式を確認してください。',
    );
  }
  if (containsCredentialField(parsed)) {
    profileError(
      '許可profileに認証情報らしき項目が含まれています。',
      '認証情報をprofileへ保存せず、公式CLIでログインしてください。',
    );
  }
  if (
    (isRecord(parsed.limits) && 'maxOutputTokens' in parsed.limits) ||
    parsed.version === 1 ||
    (isRecord(parsed.connection) &&
      ('endpoint' in parsed.connection || 'apiKeyEnv' in parsed.connection)) ||
    (isRecord(parsed.allowed) && 'endpoint' in parsed.allowed)
  ) {
    profileError(
      '旧API接続profileは使用できません。',
      '公式CLIでログインし、docs/official-cli.md の version: 2 の許可profileへ作り直してください。APIキーへのフォールバックはありません。',
    );
  }
  if (parsed.version !== 2) {
    profileError(
      '許可profileのversionが未対応です。',
      'version: 2 の許可profileを指定してください。',
    );
  }

  const allowed = requireRecord(parsed.allowed, 'allowed');
  const connection = requireRecord(parsed.connection, 'connection');
  const decision = parsed.decision;
  if (
    decision !== 'allowed' &&
    decision !== 'denied' &&
    decision !== 'revoked'
  ) {
    profileError(
      '許可profileのdecisionが不正です。',
      'decisionには allowed・denied・revoked のいずれかを指定してください。',
    );
  }

  const allowedProvider = requireString(
    allowed.provider,
    'allowed.provider',
    100,
  );
  const connectionProvider = requireString(
    connection.provider,
    'connection.provider',
    100,
  );
  if (
    allowedProvider !== SUPPORTED_PROVIDER ||
    connectionProvider !== SUPPORTED_PROVIDER
  ) {
    profileError(
      `この段階では ${SUPPORTED_PROVIDER} だけに対応しています。`,
      `providerには ${SUPPORTED_PROVIDER} を指定してください。`,
    );
  }

  const project = requireString(allowed.project, 'allowed.project', 4_000);
  if (!isAbsolute(project)) {
    profileError(
      '許可profileのallowed.projectは絶対パスで指定してください。',
      '送信を許可するプロジェクトのリポジトリルートを絶対パスで指定してください。',
    );
  }

  return {
    id: requireString(parsed.id, 'id', 100),
    decision,
    allowed: {
      provider: allowedProvider,
      project: realPathOrNull(project) ?? project,
      dataCategories: readDataCategories(allowed.dataCategories),
    },
    connection: {
      provider: connectionProvider,
      model: requireString(connection.model, 'connection.model', 200),
    },
    limits: readLimits(parsed.limits),
    execution: readExecution(parsed.execution),
    path,
  };
}

export function loadPlanningProfile(
  path: string,
  root: string,
  cwd: string,
): PlanningProfile {
  if (path.trim().length === 0) {
    profileError(
      '許可profileのパスが空です。',
      '--profile <path> または LATCH_PROFILE にワークツリー外のファイルを指定してください。',
    );
  }
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const content = readProfileFile(absolute, root);
  return parsePlanningProfile(content, absolute);
}

function scopeError(message: string): never {
  throw new RequirementPlanError(
    message,
    '利用者管理の許可profileでprovider・project・データ区分を明示してから再実行してください。',
  );
}

export function authorizePlanningScope(
  profile: PlanningProfile,
  requested: PlanningScope,
): void {
  if (profile.decision === 'revoked') {
    scopeError(
      '許可profileは取り消し済みです。同じ保存済み許可を再利用せず、送信しません。',
    );
  }
  if (profile.decision === 'denied') {
    scopeError('許可profileで送信が拒否されています。送信しません。');
  }
  if (profile.allowed.provider !== requested.provider) {
    scopeError('許可profileのproviderと送信要求のproviderが一致しません。');
  }
  if (profile.connection.provider !== requested.provider) {
    scopeError('connectionのproviderが許可範囲外です。');
  }
  const allowedProject =
    realPathOrNull(profile.allowed.project) ?? profile.allowed.project;
  const requestedProject =
    realPathOrNull(requested.project) ?? requested.project;
  if (allowedProject !== requestedProject) {
    scopeError('プロジェクトが許可profileの範囲外です。新しい許可が必要です。');
  }
  const missing = requested.dataCategories.filter(
    (category) => !profile.allowed.dataCategories.includes(category),
  );
  if (missing.length > 0) {
    scopeError(
      `データ区分（${missing.join(', ')}）が許可profileの範囲外です。新しい許可が必要です。`,
    );
  }
}
