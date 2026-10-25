import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

const workflow = readFileSync(
  new URL('../../.github/workflows/opencode.yml', import.meta.url),
  'utf8',
);
const [beforeJobs = '', jobs = ''] = workflow.split('\njobs:\n');
const [authorizeJob = '', implementJob = ''] = jobs.split('\n  implement:\n');
// Execute the actual inline authorization script with GitHub/core mocks.
const script = workflow
  .split('          script: |\n')[1]!
  .split('\n  implement:')[0]!
  .split('\n')
  .map((line) => line.slice(12))
  .join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function authorize(
  options: {
    body?: string;
    type?: string;
    permission?: string;
    actorPermission?: string;
    rerunPermission?: string;
    apiFailure?: boolean;
    pr?: 'local' | 'fork' | 'closed' | 'deleted';
    review?: boolean;
    issueState?: string;
    rerunActor?: string;
  } = {},
) {
  const output: Record<string, string> = {};
  const getPermission = vi.fn(async ({ username }: { username: string }) => {
    if (options.apiFailure) throw new Error('GitHub unavailable');
    return {
      data: {
        permission:
          username === 'actor'
            ? (options.actorPermission ?? 'write')
            : username === 'rerunner'
              ? (options.rerunPermission ?? 'write')
              : (options.permission ?? 'write'),
      },
    };
  });
  const getPR = vi.fn(async () => ({
    data: {
      state: options.pr === 'closed' ? 'closed' : 'open',
      head: {
        repo:
          options.pr === 'deleted'
            ? null
            : {
                full_name:
                  options.pr === 'fork' ? 'other/latch' : 'owner/latch',
              },
      },
    },
  }));
  const issue = {
    number: 64,
    state: options.issueState ?? 'open',
    ...(options.pr ? { pull_request: {} } : {}),
  };
  const run = new AsyncFunction('core', 'context', 'github', 'process', script);
  await run(
    { setOutput: (key: string, value: string) => (output[key] = value) },
    {
      actor: 'actor',
      repo: { owner: 'owner', repo: 'latch' },
      payload: {
        comment: {
          body: options.body ?? '/oc implement this',
          user: { login: 'author', type: options.type ?? 'User' },
        },
        ...(options.review ? { pull_request: { number: 64 } } : { issue }),
      },
    },
    {
      rest: {
        repos: { getCollaboratorPermissionLevel: getPermission },
        pulls: { get: getPR },
      },
    },
    { env: { GITHUB_TRIGGERING_ACTOR: options.rerunActor ?? 'rerunner' } },
  );
  return { output, getPermission, getPR };
}

describe('OpenCode implementation queue configuration', () => {
  test('only the authorized implementation job uses the repository queue', () => {
    expect(beforeJobs).not.toMatch(/^concurrency:/m);
    expect(authorizeJob).not.toMatch(/^\s+concurrency:/m);
    expect(workflow.match(/^\s*concurrency:/gm)).toHaveLength(1);
    expect(implementJob).toMatch(/^ {4}needs: authorize$/m);
    expect(implementJob).toMatch(
      /^ {4}if: needs\.authorize\.outputs\.allowed == 'true'$/m,
    );
    expect(implementJob).toContain(
      '    concurrency:\n' +
        '      group: opencode-${{ github.repository }}\n' +
        '      cancel-in-progress: false\n' +
        '      queue: max\n',
    );
    expect(implementJob).not.toMatch(/^ {4}strategy:/m);
  });

  test('authorization remains enabled explicitly and has no implementation credentials', () => {
    expect(authorizeJob).toMatch(/^ {4}if: vars\.OPENCODE_ENABLED == 'true'$/m);
    expect(authorizeJob).toContain(
      '      allowed: ${{ steps.authorize.outputs.allowed }}',
    );
    expect(beforeJobs + authorizeJob).not.toMatch(
      /secrets\.|id-token:|actions\/checkout@/,
    );
    expect(implementJob).toContain('      id-token: write');
    expect(implementJob).toContain('${{ secrets.DEEPSEEK_API_KEY }}');
  });
});

describe('OpenCode authorization before credentials', () => {
  test.each(['write', 'maintain', 'admin'])(
    'allows current %s permission',
    async (permission) => {
      const result = await authorize({ permission });
      expect(result.output.allowed).toBe('true');
      expect(
        result.getPermission.mock.calls.map(([arg]) => arg.username),
      ).toEqual(['author', 'actor', 'rerunner']);
    },
  );

  test.each(['/opencode implement', 'please /oc fix this', '/oc'])(
    'accepts command %s',
    async (body) => {
      expect((await authorize({ body })).output.allowed).toBe('true');
    },
  );

  test.each([
    'hello',
    '/octopus',
    '/opencode-other',
    'https://example.com/oc',
    'prefix/oc',
  ])('ignores non-command %s without permission calls', async (body) => {
    const result = await authorize({ body });
    expect(result.output.allowed).toBe('false');
    expect(result.getPermission).not.toHaveBeenCalled();
  });

  test('ignores bot comments', async () => {
    const result = await authorize({ type: 'Bot' });
    expect(result.output.allowed).toBe('false');
    expect(result.getPermission).not.toHaveBeenCalled();
  });

  test.each(['read', 'triage', 'none'])(
    'rejects %s permission',
    async (permission) => {
      await expect(authorize({ permission })).rejects.toThrow(
        'Write permission required',
      );
    },
  );

  test('rejects a rerun by a user without write access', async () => {
    await expect(authorize({ rerunPermission: 'read' })).rejects.toThrow(
      'Write permission required',
    );
  });

  test('rejects an event actor without write access', async () => {
    await expect(authorize({ actorPermission: 'read' })).rejects.toThrow(
      'Write permission required',
    );
  });

  test('rejects a missing rerun actor', async () => {
    await expect(authorize({ rerunActor: '' })).rejects.toThrow(
      'Missing actor',
    );
  });

  test('fails closed when GitHub permission lookup fails', async () => {
    await expect(authorize({ apiFailure: true })).rejects.toThrow(
      'GitHub unavailable',
    );
  });

  test('rejects a closed Issue', async () => {
    await expect(authorize({ issueState: 'closed' })).rejects.toThrow(
      'Issue must be open',
    );
  });

  test.each([false, true])(
    'allows same-repository PR follow-ups (review=%s)',
    async (review) => {
      const result = await authorize({ pr: 'local', review });
      expect(result.output.allowed).toBe('true');
      expect(result.getPR).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'latch',
        pull_number: 64,
      });
    },
  );

  test.each(
    (['fork', 'closed', 'deleted'] as const).flatMap((pr) =>
      [false, true].map((review) => ({ pr, review })),
    ),
  )('rejects $pr PR (review=$review)', async ({ pr, review }) => {
    await expect(authorize({ pr, review })).rejects.toThrow(
      'Only open same-repository PRs',
    );
  });
});
