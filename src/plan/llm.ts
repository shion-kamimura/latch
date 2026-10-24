import { RequirementPlanError } from './errors.js';
import type { PlanningLimits, PlanningProfile } from './types.js';

export interface LlmCallOptions {
  readonly profile: PlanningProfile;
  readonly apiKey: string;
  readonly system: string;
  readonly user: string;
  readonly fetch: typeof fetch;
}

export interface LlmCallResult {
  readonly content: string;
  readonly requestCount: number;
}

class TransientLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientLlmError';
  }
}

class TimeoutLlmError extends TransientLlmError {
  constructor() {
    super('LLM応答がタイムアウトしました。');
    this.name = 'TimeoutLlmError';
  }
}

function endpointUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/u, '')}/chat/completions`;
}

function limitsOf(profile: PlanningProfile): PlanningLimits {
  return profile.limits;
}

function retryMessage(attempt: number, limits: PlanningLimits): string {
  return attempt >= limits.maxRequests - 1 ? '' : '上限内で再試行します。';
}

function terminalError(message: string, guidance: string): never {
  throw new RequirementPlanError(message, guidance);
}

async function readResponseContent(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    terminalError(
      'LLM応答がJSONではありませんでした。',
      'provider・endpoint・modelの設定と応答形式を確認してください。',
    );
  }
  if (typeof body !== 'object' || body === null) {
    terminalError(
      'LLM応答の形式が不正です。',
      'OpenAI互換のchat completions応答を返すproviderを指定してください。',
    );
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    terminalError(
      'LLM応答にchoicesがありません。',
      'OpenAI互換のchat completions応答を返すproviderを指定してください。',
    );
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    terminalError(
      'LLM応答のchoices形式が不正です。',
      'OpenAI互換のchat completions応答を返すproviderを指定してください。',
    );
  }
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) {
    terminalError(
      'LLM応答にmessageがありません。',
      'OpenAI互換のchat completions応答を返すproviderを指定してください。',
    );
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    terminalError(
      'LLM応答のcontentが空です。',
      '要件抽出用のJSONを返すモデル・endpointを指定してください。',
    );
  }
  return content;
}

async function callOnce(
  options: LlmCallOptions,
  limits: PlanningLimits,
): Promise<string> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutLlmError());
    }, limits.timeoutMs);
  });

  try {
    const operation = (async (): Promise<string> => {
      const response = await options.fetch(
        endpointUrl(options.profile.connection.endpoint),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.profile.connection.model,
            messages: [
              { role: 'system', content: options.system },
              { role: 'user', content: options.user },
            ],
            temperature: 0,
            max_tokens: limits.maxOutputTokens,
          }),
          signal: controller.signal,
        },
      );

      if (response.status === 401 || response.status === 403) {
        terminalError(
          'LLMの認証に失敗しました。',
          'BYOKのAPIキーとprovider設定を確認してください。キーは表示していません。',
        );
      }
      if (response.status === 429) {
        terminalError(
          'LLMの利用上限またはレート制限に達しました。',
          '利用上限・残高を確認し、無制限に再試行せず設定を見直してください。',
        );
      }
      if (response.status >= 500) {
        throw new TransientLlmError(
          `LLMが一時的なHTTPエラー（${response.status}）を返しました。`,
        );
      }
      if (!response.ok) {
        terminalError(
          `LLMがリクエストを拒否しました（HTTP ${response.status}）。`,
          'providerのendpoint・model・リクエスト形式を確認してください。',
        );
      }
      return await readResponseContent(response);
    })();
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (
      error instanceof RequirementPlanError ||
      error instanceof TransientLlmError
    ) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new TimeoutLlmError();
    }
    throw new TransientLlmError('LLMへ接続できませんでした。');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function callPlanningLlm(
  options: LlmCallOptions,
): Promise<LlmCallResult> {
  const limits = limitsOf(options.profile);
  let requestCount = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < limits.maxRequests; attempt += 1) {
    requestCount += 1;
    try {
      const content = await callOnce(options, limits);
      return { content, requestCount };
    } catch (error) {
      lastError = error;
      if (!(error instanceof TransientLlmError)) throw error;
      if (attempt >= limits.maxRequests - 1) break;
      const note = retryMessage(attempt + 1, limits);
      if (note.length > 0) continue;
    }
  }

  const detail =
    lastError instanceof Error
      ? lastError.message
      : 'LLM呼び出しに失敗しました。';
  terminalError(
    `${detail}（呼び出し回数: ${requestCount}、上限: ${limits.maxRequests}）`,
    '時間・回数の上限内で停止しました。providerの状態と利用上限を確認してから再実行してください。',
  );
}
