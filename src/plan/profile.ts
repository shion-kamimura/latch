import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { RequirementPlanError } from './errors.js';
import type {
  DataCategory,
  PlanningLimits,
  PlanningProfile,
  PlanningScope,
} from './types.js';
import { isInside, realPathOrNull } from '../verify/paths.js';

export const SUPPORTED_PROVIDER = 'openai-compatible';
export const DEFAULT_API_KEY_ENV = 'LATCH_API_KEY';

const MAX_PROFILE_BYTES = 64 * 1024;
const DATA_CATEGORIES: readonly DataCategory[] = ['issue', 'diff', 'tests'];
const HARD_LIMITS: PlanningLimits = {
  maxRequests: 3,
  timeoutMs: 120_000,
  maxOutputTokens: 8192,
  maxInputCharacters: 200_000,
};
const DEFAULT_LIMITS: PlanningLimits = {
  maxRequests: 2,
  timeoutMs: 30_000,
  maxOutputTokens: 4096,
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

export function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    profileError(
      '許可profileのendpointがURLとして解釈できません。',
      'providerのHTTPS endpointを許可profileへ指定してください。',
    );
  }
  const https = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && loopbackHost(url.hostname);
  if (!https && !localHttp) {
    profileError(
      '許可profileのendpointはHTTPS（またはloopbackのHTTP）である必要があります。',
      '平文の外部endpointは指定しないでください。',
    );
  }
  if (url.username || url.password) {
    profileError(
      '許可profileのendpointに認証情報を含めないでください。',
      'APIキーは環境変数から読み込み、endpointへ埋め込まないでください。',
    );
  }
  if (url.search || url.hash) {
    profileError(
      '許可profileのendpointにqueryやfragmentを含めないでください。',
      'providerのbase URLだけを指定してください。',
    );
  }
  const path = url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${path}`;
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
    maxOutputTokens: boundedInteger(
      limits.maxOutputTokens,
      DEFAULT_LIMITS.maxOutputTokens,
      256,
      HARD_LIMITS.maxOutputTokens,
    ),
    maxInputCharacters: boundedInteger(
      limits.maxInputCharacters,
      DEFAULT_LIMITS.maxInputCharacters,
      1_000,
      HARD_LIMITS.maxInputCharacters,
    ),
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
      'APIキー・認証ヘッダー・tokenをprofileへ保存せず、環境変数から読み込んでください。',
    );
  }
  if (parsed.version !== 1) {
    profileError(
      '許可profileのversionが未対応です。',
      'version: 1 の許可profileを指定してください。',
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

  const allowedEndpoint = normalizeEndpoint(
    requireString(allowed.endpoint, 'allowed.endpoint', 2_000),
  );
  const connectionEndpoint = normalizeEndpoint(
    requireString(connection.endpoint, 'connection.endpoint', 2_000),
  );
  const project = requireString(allowed.project, 'allowed.project', 4_000);
  if (!isAbsolute(project)) {
    profileError(
      '許可profileのallowed.projectは絶対パスで指定してください。',
      '送信を許可するプロジェクトのリポジトリルートを絶対パスで指定してください。',
    );
  }
  const apiKeyEnv = requireString(
    connection.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    'connection.apiKeyEnv',
    100,
  );
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(apiKeyEnv)) {
    profileError(
      '許可profileのconnection.apiKeyEnvが環境変数名として不正です。',
      '大文字・数字・アンダースコアだけの環境変数名を指定してください。',
    );
  }

  return {
    id: requireString(parsed.id, 'id', 100),
    decision,
    allowed: {
      provider: allowedProvider,
      endpoint: allowedEndpoint,
      project: realPathOrNull(project) ?? project,
      dataCategories: readDataCategories(allowed.dataCategories),
    },
    connection: {
      provider: connectionProvider,
      endpoint: connectionEndpoint,
      model: requireString(connection.model, 'connection.model', 200),
      apiKeyEnv,
    },
    limits: readLimits(parsed.limits),
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
    '利用者管理の許可profileでprovider・endpoint・project・データ区分を明示してから再実行してください。',
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
  if (profile.connection.endpoint !== requested.endpoint) {
    scopeError('connectionのendpointが許可範囲外です。');
  }
  if (profile.allowed.endpoint !== requested.endpoint) {
    scopeError('endpointが許可profileの範囲外です。新しい許可が必要です。');
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

export function resolveApiKey(
  profile: PlanningProfile,
  env: NodeJS.ProcessEnv,
): string {
  const value = env[profile.connection.apiKeyEnv];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RequirementPlanError(
      `BYOKのAPIキー（環境変数 ${profile.connection.apiKeyEnv}）が設定されていません。`,
      'APIキーはprofile・ログ・レポートへ保存せず、環境変数から設定してください。',
    );
  }
  return value;
}
