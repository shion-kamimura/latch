import { spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RequirementPlanError } from './errors.js';
import type { PlanningLimits, PlanningProfile } from './types.js';

// Revalidate permissions and the JSON envelope before accepting another version.
export const SUPPORTED_CLI_VERSION = '2.1.310';
export interface PlanningCliRequest {
  readonly system: string;
  readonly user: string;
  readonly model: string;
  readonly output?: 'requirements' | 'tests';
  readonly limits: PlanningLimits;
  readonly env: NodeJS.ProcessEnv;
}
export type PlanningCli = (request: PlanningCliRequest) => Promise<string>;
export interface LlmCallOptions {
  readonly profile: PlanningProfile;
  readonly system: string;
  readonly user: string;
  readonly env: NodeJS.ProcessEnv;
  readonly invokeCli?: PlanningCli;
  readonly output?: 'requirements' | 'tests';
}
export interface LlmCallResult {
  readonly content: string;
  readonly requestCount: number;
}
function fail(message: string): never {
  throw new RequirementPlanError(
    message,
    '公式CLIの導入・ログイン・契約と利用上限を確認してください。応答・認証情報は表示せず、API接続への切替や自動再試行は行いません。',
  );
}
export function cliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // Only the official CLI resolves credentials. Do not forward API keys, OAuth
  // token variables, NODE_OPTIONS, or SDK/provider overrides.
  for (const key of [
    'HOME',
    'PATH',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function requireAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail('管理者設定の有無を確認できないため、公式CLIを起動しません。');
  }
  fail(
    '管理者設定の配置先またはキャッシュがある環境は未対応です。公式CLIを起動しません。',
  );
}

// Only metadata of documented policy locations is checked. Never enumerate HOME
// or read a credential file, and never delete/override an administrator's policy.
export function assertCliHost(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'linux' || /microsoft/i.test(release()))
    fail('公式CLI接続は現在Linux（WSL以外）だけに対応しています。');
  const home = env.HOME;
  if (!home || !isAbsolute(home))
    fail('公式CLIの利用には絶対パスのHOMEが必要です。');
  requireAbsent('/etc/claude-code');
  requireAbsent(join(home, '.claude', 'remote-settings.json'));
  return join(home, '.claude');
}
interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
}
function execute(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBytes: number,
  input = '',
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [...args], {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let failure: string | undefined;
    const kill = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const cancel = () => {
      failure = '公式CLIの実行をキャンセルしました。';
      kill();
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const timer = setTimeout(() => {
      failure = '公式CLIの応答がタイムアウトしました。';
      kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = '公式CLIの出力が上限を超えました。';
        kill();
      } else output += decoder.write(chunk);
    });
    // Errors can contain account details: never forward stderr.
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = '公式CLIの出力が上限を超えました。';
        kill();
      }
    });
    child.stdin.on('error', () => {
      /* close/error determines the result */
    });
    child.stdin.end(input);
    child.once('error', (error: NodeJS.ErrnoException) => {
      failure =
        error.code === 'ENOENT'
          ? '公式CLI（claude）が未導入です。'
          : '公式CLIを起動できませんでした。';
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      if (failure) {
        try {
          fail(failure);
        } catch (error) {
          reject(error);
        }
      } else resolve({ code, stdout: output + decoder.end() });
    });
  });
}
function jsonObject(text: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(text);
    if (typeof result === 'object' && result !== null && !Array.isArray(result))
      return result as Record<string, unknown>;
  } catch {
    /* raw output is deliberately withheld */
  }
  fail('公式CLIが不正なJSON出力を返しました。');
}
const RESTRICTED_ARGUMENTS = [
  '--safe-mode',
  '--restricted',
  '--setting-sources',
  '',
  '--settings',
  JSON.stringify({ disableAllHooks: true }),
];

export function officialCliArguments(request: PlanningCliRequest): string[] {
  const field = request.output ?? 'requirements';
  return [
    ...RESTRICTED_ARGUMENTS,
    '-p',
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--max-turns',
    '1',
    '--model',
    request.model,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify({
      type: 'object',
      properties: {
        [field]: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: [field],
      additionalProperties: true,
    }),
    '--system-prompt',
    request.system,
  ];
}
export const invokeOfficialCli: PlanningCli = async (request) => {
  const env = cliEnvironment(request.env);
  const configDirectory = assertCliHost(env);
  const directory = mkdtempSync(join(tmpdir(), 'latch-cli-'));
  // One deadline includes version and auth checks, without automatic retries.
  const deadline = Date.now() + request.limits.timeoutMs;
  const run = (args: string[], input = '') => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('公式CLIの応答がタイムアウトしました。');
    return execute(
      args,
      directory,
      env,
      remaining,
      request.limits.maxOutputBytes,
      input,
    );
  };
  try {
    const version = await run(['--version']);
    if (
      version.code !== 0 ||
      version.stdout.trim() !== `${SUPPORTED_CLI_VERSION} (Claude Code)`
    )
      fail(`公式CLIの対応バージョンは ${SUPPORTED_CLI_VERSION} です。`);
    const auth = await run([...RESTRICTED_ARGUMENTS, 'auth', 'status']);
    if (auth.code !== 0) fail('公式CLIが未ログインです。');
    const status = jsonObject(auth.stdout);
    if (status.loggedIn !== true || status.authMethod !== 'claude.ai')
      fail('公式CLIのClaudeアカウントへのログインが必要です。');
    // Remote policy is available to Team/Enterprise. Unknown output from this
    // pinned CLI is rejected, rather than assuming that the account is unmanaged.
    if (status.subscriptionType !== 'pro' && status.subscriptionType !== 'max')
      fail('公式CLI接続は現在Pro/Maxアカウントだけに対応しています。');
    if (
      status.apiProvider !== 'firstParty' ||
      status.configDirectory !== configDirectory
    )
      fail('公式CLIの接続先または設定ディレクトリが対応条件と一致しません。');
    assertCliHost(env);
    const result = await run(officialCliArguments(request), request.user);
    const body = jsonObject(result.stdout);
    if (body.is_error === true || result.code !== 0) {
      const errors = JSON.stringify(body.errors ?? body.result ?? '');
      if (
        /rate.?limit|usage.?limit|quota|capacity|extra usage|hit your limit/i.test(
          errors,
        )
      )
        fail('公式CLIの利用上限またはレート制限に達しました。');
      if (/auth|login|log in|sign in|credential|expired/i.test(errors))
        fail('公式CLIの認証に失敗しました。');
      fail(
        '公式CLIの実行に失敗しました（権限・利用上限・実行回数を確認してください）。',
      );
    }
    if (
      body.is_error !== false ||
      body.type !== 'result' ||
      body.subtype !== 'success' ||
      typeof body.structured_output !== 'object' ||
      body.structured_output === null ||
      Array.isArray(body.structured_output)
    )
      fail('公式CLIの構造化出力が不正です。');
    return JSON.stringify(body.structured_output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
export async function callPlanningLlm(
  options: LlmCallOptions,
): Promise<LlmCallResult> {
  if (
    options.system.length + options.user.length >
    options.profile.limits.maxInputCharacters
  )
    fail('公式CLIへ渡す入力が上限を超えています。');
  const content = await (options.invokeCli ?? invokeOfficialCli)({
    system: options.system,
    user: options.user,
    model: options.profile.connection.model,
    limits: options.profile.limits,
    env: options.env,
    output: options.output,
  });
  return { content, requestCount: 1 };
}
