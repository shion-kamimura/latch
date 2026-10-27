import { isInside } from '../verify/paths.js';
import { startTimeout } from '../limits.js';
import { spawn } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { release, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RequirementPlanError } from './errors.js';
import type { PlanningLimits, PlanningProfile } from './types.js';

// Revalidate permissions and the JSON envelope before accepting another version.
import {
  codexOutputSchema,
  codexPolicyArguments,
  SUPPORTED_CLI_VERSION,
} from './codex-policy.js';
export { SUPPORTED_CLI_VERSION } from './codex-policy.js';
export interface PlanningCliRequest {
  readonly system: string;
  readonly user: string;
  readonly model: string;
  readonly project?: string;
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
    'CODEX_HOME',
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
  throw new RequirementPlanError(
    'CLI設定または管理者設定のある環境は未対応です。公式CLIを起動しません。',
    '利用者設定がある場合は、ワークツリー外の専用CODEX_HOMEで公式のcodex loginを行ってください。システム管理設定があるホストは初回対象外です。docs/official-cli.md を参照してください。',
  );
}

// Resolve even a not-yet-created CODEX_HOME through existing symlink parents.
function prospectivePath(path: string): string {
  let parent = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(parent), ...suffix);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        dirname(parent) === parent
      )
        fail('公式CLIのHOME/CODEX_HOMEの実体を確認できませんでした。');
      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

// Only metadata of documented policy locations is checked. Never enumerate HOME
// or read a credential file, and never delete/override an administrator's policy.
export function assertCliHost(
  env: NodeJS.ProcessEnv,
  project?: string,
): string {
  if (process.platform !== 'linux')
    fail('公式CLI接続は現在Linux・WSL 2上のLinuxだけに対応しています。');
  const kernel = release().toLowerCase();
  // Codex 0.163.0 requires Linux namespaces and excludes WSL 1. Recognize
  // current WSL2 and older microsoft-standard kernels, without trusting the
  // presence of WSL environment variables as proof of the kernel version.
  const wslVersion = /(?:^|[-_])wsl(\d+)(?:[-_]|$)/.exec(kernel)?.[1];
  if (
    /microsoft|wsl/.test(kernel) &&
    (wslVersion !== undefined
      ? wslVersion !== '2'
      : !/microsoft-standard(?:[-_]|$)/.test(kernel))
  )
    fail(
      'WSL 1または判別できないWSLカーネルには未対応です。WSL 2上のUbuntuを使ってください。',
    );
  const home = env.HOME;
  if (!home || !isAbsolute(home))
    fail('公式CLIの利用には絶対パスのHOMEが必要です。');
  const codexHome = env.CODEX_HOME ?? join(home, '.codex');
  if (!isAbsolute(codexHome))
    fail('CODEX_HOMEはワークツリー外の絶対パスで指定してください。');
  if (
    project &&
    [home, codexHome].some((path) => isInside(project, prospectivePath(path)))
  )
    fail('公式CLIのHOME/CODEX_HOMEは対象ワークツリー外に置いてください。');
  for (const name of [
    'config.toml',
    'requirements.toml',
    'managed_config.toml',
  ])
    requireAbsent(join('/etc/codex', name));
  requireAbsent(join(codexHome, 'config.toml'));
  requireAbsent(join(codexHome, 'requirements.toml'));
  return codexHome;
}
interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
}
function execute(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number | null,
  maxBytes: number | null,
  input = '',
  accountRpc = false,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', [...args], {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let rpcBuffer = '';
    const send = (value: unknown) =>
      child.stdin.write(`${JSON.stringify(value)}\n`);
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
    const stopTimer = startTimeout(timeoutMs, () => {
      failure = '公式CLIの応答がタイムアウトしました。';
      kill();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (maxBytes !== null && bytes > maxBytes) {
        failure = '公式CLIの出力が上限を超えました。';
        kill();
      } else {
        const decoded = decoder.write(chunk);
        output += decoded;
        if (accountRpc) {
          rpcBuffer += decoded;
          let end: number;
          while ((end = rpcBuffer.indexOf('\n')) >= 0) {
            const line = rpcBuffer.slice(0, end);
            rpcBuffer = rpcBuffer.slice(end + 1);
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line) as {
                id?: number;
                error?: unknown;
              };
              if (message.id === 1) {
                if (message.error) {
                  failure = '公式CLIの状態確認を開始できませんでした。';
                  kill();
                } else {
                  send({ method: 'initialized', params: {} });
                  send({
                    id: 2,
                    method: 'account/read',
                    params: { refreshToken: false },
                  });
                }
              }
              if (message.id === 2) child.stdin.end();
            } catch {
              failure = '公式CLIの状態確認が不正なJSONを返しました。';
              kill();
            }
          }
        }
      }
    });
    // Errors can contain account details: never forward stderr.
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (maxBytes !== null && bytes > maxBytes) {
        failure = '公式CLIの出力が上限を超えました。';
        kill();
      }
    });
    child.stdin.on('error', () => {
      /* close/error determines the result */
    });
    if (accountRpc)
      send({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'latch', version: '0.0.0' } },
      });
    else child.stdin.end(input);
    child.once('error', (error: NodeJS.ErrnoException) => {
      failure =
        error.code === 'ENOENT'
          ? '公式CLI（codex）が未導入です。'
          : '公式CLIを起動できませんでした。';
    });
    child.once('close', (code) => {
      stopTimer();
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
export function officialCliArguments(
  request: PlanningCliRequest,
  schemaPath: string,
): string[] {
  return [
    ...codexPolicyArguments(),
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
    '--model',
    request.model,
    '--output-schema',
    schemaPath,
    '-c',
    `developer_instructions=${JSON.stringify(request.system)}`,
    '-',
  ];
}

function cliError(value: unknown): never {
  const error = JSON.stringify(value);
  if (
    /rate.?limit|usage.?limit|quota|usage_limit_reached|insufficient_quota|hit your limit/i.test(
      error,
    )
  )
    fail('公式CLIの利用上限またはレート制限に達しました。');
  if (
    /auth|login|log in|sign in|credential|expired|unauthorized|401/i.test(error)
  )
    fail('公式CLIの認証に失敗しました。');
  if (
    /model.*(?:not supported|unsupported|not available|unavailable|does not exist|not found|retired|deprecated)|unsupported_model|model_not_found|model_not_available|(?:do|does) not have access to.*model/i.test(
      error,
    )
  )
    throw new RequirementPlanError(
      '公式CLIで指定モデルを利用できません。',
      '公式のモデル提供状況と契約を確認し、利用者管理profileのconnection.modelを利用可能なモデルへ変更してください。モデルやAPI接続の自動切替は行いません。',
    );
  fail('公式CLIの実行に失敗しました。');
}

function events(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map(jsonObject);
}

export const invokeOfficialCli: PlanningCli = async (request) => {
  const env = cliEnvironment(request.env);
  env.CODEX_HOME = assertCliHost(env, request.project);
  const directory = mkdtempSync(join(tmpdir(), 'latch-cli-'));
  // An explicitly chosen deadline includes preflight. No deadline by default.
  const deadline =
    request.limits.timeoutMs === null
      ? null
      : Date.now() + request.limits.timeoutMs;
  const run = (args: string[], input = '', accountRpc = false) => {
    const remaining = deadline === null ? null : deadline - Date.now();
    if (remaining !== null && remaining <= 0)
      fail('公式CLIの応答がタイムアウトしました。');
    return execute(
      args,
      directory,
      env,
      remaining,
      request.limits.maxOutputBytes,
      input,
      accountRpc,
    );
  };
  try {
    const version = await run(['--version']);
    if (
      version.code !== 0 ||
      version.stdout.trim() !== `codex-cli ${SUPPORTED_CLI_VERSION}`
    )
      fail(`公式CLIの対応バージョンは ${SUPPORTED_CLI_VERSION} です。`);
    const auth = await run(
      [...codexPolicyArguments(), 'app-server', '--stdio', '--strict-config'],
      '',
      true,
    );
    const response = events(auth.stdout).find((value) => value.id === 2);
    if (auth.code !== 0 || !response || response.error)
      fail('公式CLIのログイン状態を確認できませんでした。');
    const result = response.result as {
      account?: { type?: string; planType?: string } | null;
      requiresOpenaiAuth?: boolean;
    };
    if (!result?.account) fail('公式CLIが未ログインです。');
    if (result.requiresOpenaiAuth !== true)
      fail('公式CLIの接続先を確認できませんでした。');
    if (result.account.type !== 'chatgpt')
      fail('公式CLIでChatGPTアカウントへのログインが必要です。');
    if (!['plus', 'pro'].includes(result.account.planType ?? ''))
      fail('公式CLI接続は現在ChatGPT Plus/Proアカウントだけに対応しています。');
    assertCliHost(env, request.project);
    const schemaPath = join(directory, 'output-schema.json');
    writeFileSync(
      schemaPath,
      JSON.stringify(codexOutputSchema(request.output)),
      { mode: 0o600 },
    );
    const execution = await run(
      officialCliArguments(request, schemaPath),
      request.user,
    );
    const stream = events(execution.stdout);
    const error = stream.find(
      (value) => value.type === 'error' || value.type === 'turn.failed',
    );
    if (error || execution.code !== 0) cliError(error ?? {});
    const items = stream
      .filter((value) => value.type === 'item.completed')
      .map((value) => value.item as { type?: string; text?: string });
    if (
      items.some(
        (item) =>
          !item || !['agent_message', 'reasoning'].includes(item.type ?? ''),
      )
    )
      fail('公式CLIが許可していないツール操作を試みました。');
    const message = items.findLast(
      (item) => item.type === 'agent_message',
    )?.text;
    if (
      !stream.some((value) => value.type === 'turn.completed') ||
      typeof message !== 'string'
    )
      fail('公式CLIの構造化出力が不正です。');
    return JSON.stringify(jsonObject(message));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
export async function callPlanningLlm(
  options: LlmCallOptions,
): Promise<LlmCallResult> {
  if (
    options.profile.limits.maxInputCharacters !== null &&
    options.system.length + options.user.length >
      options.profile.limits.maxInputCharacters
  )
    fail('公式CLIへ渡す入力が上限を超えています。');
  const content = await (options.invokeCli ?? invokeOfficialCli)({
    project: options.profile.allowed.project,
    system: options.system,
    user: options.user,
    model: options.profile.connection.model,
    limits: options.profile.limits,
    env: options.env,
    output: options.output,
  });
  return { content, requestCount: 1 };
}
