import { afterEach, describe, expect, test, vi } from 'vitest';
import { RequirementPlanError } from '../../src/plan/errors.js';
import { callPlanningLlm } from '../../src/plan/llm.js';
import { parsePlanningProfile } from '../../src/plan/profile.js';
import type { PlanningProfile } from '../../src/plan/types.js';
import { createTemporaryDirectory, profileContent } from '../helpers/plan.js';

const directories: { cleanup(): void }[] = [];

function temporary() {
  const directory = createTemporaryDirectory();
  directories.push(directory);
  return directory;
}

function profile(
  overrides: { maxRequests?: number; timeoutMs?: number } = {},
): PlanningProfile {
  const project = temporary().root;
  return parsePlanningProfile(
    profileContent(project, {
      limits: {
        maxRequests: overrides.maxRequests ?? 2,
        timeoutMs: overrides.timeoutMs ?? 1_000,
      },
    }),
    '/tmp/profile.json',
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function success(content: string): Response {
  return jsonResponse({
    choices: [{ message: { content } }],
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) directory.cleanup();
});

describe('LLM planning client', () => {
  test('sends one bounded OpenAI-compatible request and returns content', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      success('{"requirements":[]}'),
    );
    const result = await callPlanningLlm({
      profile: profile(),
      apiKey: 'secret-key',
      system: 'system',
      user: 'user',
      fetch: fetchMock,
    });

    expect(result).toEqual({
      content: '{"requirements":[]}',
      requestCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://llm.example.test/v1/chat/completions');
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      max_tokens: number;
    };
    expect(body.model).toBe('test-model');
    expect(body.max_tokens).toBe(4096);
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });

  test('stops immediately on authentication failure', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('unauthorized', { status: 401 }),
    );
    const error = await callPlanningLlm({
      profile: profile(),
      apiKey: 'secret-key',
      system: 'system',
      user: 'user',
      fetch: fetchMock,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequirementPlanError);
    expect((error as RequirementPlanError).message).toContain('認証');
    expect((error as RequirementPlanError).message).not.toContain('secret-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not retry a usage-limit response', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('rate limited', { status: 429 }),
    );
    const error = await callPlanningLlm({
      profile: profile(),
      apiKey: 'secret-key',
      system: 'system',
      user: 'user',
      fetch: fetchMock,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequirementPlanError);
    expect((error as RequirementPlanError).message).toContain('利用上限');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('bounds transient retries by maxRequests', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('temporary', { status: 503 }),
    );
    const error = await callPlanningLlm({
      profile: profile({ maxRequests: 3 }),
      apiKey: 'secret-key',
      system: 'system',
      user: 'user',
      fetch: fetchMock,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequirementPlanError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((error as RequirementPlanError).message).toContain('3');
  });

  test('times out and retries only within the configured budget', async () => {
    const base = profile();
    const timeoutProfile: PlanningProfile = {
      ...base,
      limits: { ...base.limits, maxRequests: 2, timeoutMs: 20 },
    };
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Promise<Response>(() => {}),
    );
    const error = await callPlanningLlm({
      profile: timeoutProfile,
      apiKey: 'secret-key',
      system: 'system',
      user: 'user',
      fetch: fetchMock,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequirementPlanError);
    expect((error as RequirementPlanError).message).toContain('タイムアウト');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('rejects malformed provider responses without retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('not json', { status: 200 }),
    );
    const error = await callPlanningLlm({
      profile: profile(),
      apiKey: 'secret-key',
      system: 'system',
      user: 'user',
      fetch: fetchMock,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequirementPlanError);
    expect((error as RequirementPlanError).message).toContain('JSON');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
