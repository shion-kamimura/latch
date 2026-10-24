import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { discoverVitestCandidates } from '../../src/plan/test-candidates.js';
import { runCli } from '../../src/run-cli.js';
import { resolveVerificationInputs } from '../../src/verify/resolve-inputs.js';
import {
  createProfileDirectory,
  createTemporaryDirectory,
  profileContent,
} from '../helpers/plan.js';
import {
  createTestRepository,
  type TestRepository,
} from '../helpers/repository.js';

const fixtureRoot = fileURLToPath(
  new URL('../../fixtures/order-api', import.meta.url),
);
const repositories: TestRepository[] = [];
const directories: { cleanup(): void }[] = [];

const GENERATED_CODE = [
  "import { expect, test } from 'vitest';",
  "import { calculateOrder } from '../../src/api.ts';",
  '',
  "test('floors fractional discount cents', () => {",
  '  expect(',
  '    calculateOrder({',
  "      lines: [{ sku: 'SKU-003', quantity: 1, unitPriceCents: 99 }],",
  "      couponCode: 'SAVE10',",
  '    }),',
  '  ).toEqual({',
  '    ok: true,',
  "    value: { subtotalCents: 99, totalCents: 90, appliedCoupon: 'SAVE10' },",
  '  });',
  '});',
  '',
].join('\n');

function temporary() {
  const directory = createTemporaryDirectory();
  directories.push(directory);
  return directory;
}

function profileDirectory() {
  const directory = createProfileDirectory();
  directories.push(directory);
  return directory;
}

function copyFixtureFile(repo: TestRepository, path: string): void {
  repo.write(path, readFileSync(join(fixtureRoot, path)));
}

function repositoryWithChange(change: 'correct' | 'buggy'): TestRepository {
  const repo = createTestRepository();
  repositories.push(repo);
  for (const path of [
    'package.json',
    'tsconfig.json',
    'vitest.config.ts',
    'src/api.ts',
    'test/existing.test.ts',
    'issue.md',
  ]) {
    copyFixtureFile(repo, path);
  }
  repo.commit('fixture base');
  repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  repo.git(['apply', join(fixtureRoot, 'changes', `${change}.patch`)]);
  repo.commit(`apply ${change} change`);
  repo.write(
    'evaluation/cases.json',
    JSON.stringify({ sentinel: 'ground-truth-sentinel' }),
  );
  return repo;
}

function planFile(
  repo: TestRepository,
  directory: { readonly root: string },
): string {
  const snapshot = resolveVerificationInputs(
    {
      base: 'origin/main',
      issueFile: 'issue.md',
      includeUntracked: [],
      json: false,
    },
    repo.root,
  );
  const candidates = discoverVitestCandidates(repo.root);
  const conditionId = 'cond-discount-floor';
  const plan = {
    phase: 'requirement-planning',
    verification: 'not-run',
    input: {
      repository: snapshot.repository,
      base: {
        ref: snapshot.base.ref,
        commit: snapshot.base.commit,
        mergeBase: snapshot.base.mergeBase,
      },
      issue: {
        path: snapshot.issue?.path,
        title: snapshot.issue?.title,
        state: snapshot.issue?.state,
        source: snapshot.issue?.source,
      },
      diff: {
        files: snapshot.diff.files,
        excluded: snapshot.diff.excluded,
        digest: snapshot.diff.digest,
      },
      options: {
        base: 'origin/main',
        issueFile: 'issue.md',
        includeUntracked: [],
      },
      snapshotDigest: snapshot.digest,
    },
    requirements: [
      {
        id: 'req-discount',
        text: 'Discounts are floored to whole cents.',
        source: {
          kind: 'issue',
          path: 'issue.md',
          line: 11,
          label: 'issue:issue.md#L11',
        },
        origin: 'issue-explicit',
        state: 'unverified',
        ambiguity: null,
        conditions: [
          {
            id: conditionId,
            requirementId: 'req-discount',
            text: '99 cents with SAVE10 totals 90 cents.',
            source: {
              kind: 'diff',
              path: 'src/api.ts',
              line: null,
              label: 'diff:src/api.ts',
            },
            origin: 'diff-inferred',
            state: 'unverified',
            ambiguity: null,
            existingTestCandidateIds: [],
            missingScenarios: [
              {
                id: 'scenario-discount-floor',
                conditionId,
                description:
                  'A fractional discount cent is floored, not rounded.',
                rationale: 'Existing tests only use amounts divisible by 10.',
                state: 'unverified',
                evidence: 'none',
              },
            ],
          },
        ],
      },
    ],
    testCandidates: candidates.candidates.map((candidate) => ({
      id: candidate.id,
      path: candidate.path,
      name: candidate.name,
      framework: 'vitest',
      matchedConditionIds: [],
    })),
    unverified: ['Tests have not run.'],
    notes: [],
    warnings: [],
    digest: 'test-plan-digest',
    rerunCommand: 'latch plan --base origin/main --issue-file issue.md',
  };
  const path = join(directory.root, 'plan.json');
  writeFileSync(path, JSON.stringify(plan, null, 2));
  return path;
}

const INVALID_GENERATED_CODE = [
  "import { expect, test } from 'vitest';",
  "import { calculateOrder } from '../../src/api.ts';",
  "test('broken', () => {",
  '  expect(calculateOrder({ lines: [] })).toEqual({ ok: false });',
].join('\n');

function llmResponse(code = GENERATED_CODE): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              tests: [
                {
                  conditionId: 'cond-discount-floor',
                  name: 'floors fractional discount cents',
                  rationale: '99 * 10% is 9.9 cents, floored to 9.',
                  code,
                },
              ],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function recordingFetch(code = GENERATED_CODE): {
  fetch: typeof fetch;
  bodies: string[];
} {
  const bodies: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    bodies.push(String(init?.body ?? ''));
    return llmResponse(code);
  });
  return { fetch: fetchMock, bodies };
}

async function run(
  repo: TestRepository,
  planPath: string,
  profilePath: string,
  fetchImpl: typeof fetch,
) {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  const status = await runCli(
    ['run', '--plan', planPath, '--profile', profilePath, '--json'],
    io,
    {
      cwd: repo.root,
      env: { LATCH_API_KEY: 'secret-value' },
      fetch: fetchImpl,
    },
  );
  return { status, io };
}

function gitStatus(repo: TestRepository): string {
  return repo.git(['status', '--porcelain']);
}

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.cleanup();
  for (const directory of directories.splice(0)) directory.cleanup();
});

describe('run command isolated execution', () => {
  test.each([
    ['correct', 'verified', 'passed'],
    ['buggy', 'failed', 'assertion-failed'],
  ] as const)(
    'distinguishes the %s change as %s',
    async (change, conditionState, evidenceStatus) => {
      const repo = repositoryWithChange(change);
      const planPath = planFile(repo, temporary());
      const profile = profileDirectory().write(
        'profile.json',
        profileContent(repo.root),
      );
      const recorder = recordingFetch();
      const before = gitStatus(repo);

      const { status, io } = await run(repo, planPath, profile, recorder.fetch);

      expect(status).toBe(0);
      const report = JSON.parse(io.stdout.mock.calls[0]?.[0] as string) as {
        phase: string;
        verification: string;
        conditions: {
          conditionId: string;
          state: string;
          evidenceIds: string[];
        }[];
        evidence: {
          kind: string;
          status: string;
          conditionIds: string[];
          command: string;
          exitCode: number | null;
          content: string | null;
        }[];
        isolation: {
          mode: string;
          network: string;
          credentials: string;
          cleanup: { status: string };
        };
        warnings: string[];
      };

      expect(report.phase).toBe('isolated-execution');
      expect(report.conditions[0]?.conditionId).toBe('cond-discount-floor');
      expect(report.conditions[0]?.state).toBe(conditionState);
      const generated = report.evidence.find(
        (item) => item.kind === 'generated',
      );
      expect(generated).toMatchObject({
        status: evidenceStatus,
        conditionIds: ['cond-discount-floor'],
        content: GENERATED_CODE,
      });
      expect(generated?.command).toContain('--root <isolated-root>');
      expect(generated?.exitCode).not.toBeNull();
      expect(report.isolation).toMatchObject({
        mode: 'process',
        network: 'blocked',
        credentials: 'not-forwarded',
        cleanup: { status: 'removed' },
      });
      expect(report.verification).toBe('completed');
      expect(gitStatus(repo)).toBe(before);
      expect(io.stdout.mock.calls[0]?.[0]).not.toContain('secret-value');
      expect(recorder.bodies[0]).not.toContain('ground-truth-sentinel');
    },
  );

  test('does not treat an invalid generated test as a product failure', async () => {
    const repo = repositoryWithChange('correct');
    const planPath = planFile(repo, temporary());
    const profile = profileDirectory().write(
      'profile.json',
      profileContent(repo.root),
    );
    const recorder = recordingFetch(INVALID_GENERATED_CODE);

    const { status, io } = await run(repo, planPath, profile, recorder.fetch);

    expect(status).toBe(0);
    const report = JSON.parse(io.stdout.mock.calls[0]?.[0] as string) as {
      conditions: { state: string; notes: string[] }[];
      evidence: { kind: string; status: string }[];
      generation: { repairAttempts: number; maxRepairAttempts: number };
    };
    expect(report.generation.repairAttempts).toBe(1);
    expect(report.generation.maxRepairAttempts).toBe(1);
    expect(
      report.evidence.find((item) => item.kind === 'generated')?.status,
    ).toBe('invalid-generated-test');
    expect(report.conditions[0]?.state).toBe('unverified');
    expect(report.conditions[0]?.notes.join('')).toContain(
      '製品不具合の証拠として扱いません',
    );
    expect(recorder.bodies).toHaveLength(2);
  });

  test('fails closed without a profile and does not execute tests', async () => {
    const repo = repositoryWithChange('correct');
    const planPath = planFile(repo, temporary());
    const before = gitStatus(repo);
    const fetchMock = vi.fn<typeof fetch>(async () => llmResponse());
    const io = { stdout: vi.fn(), stderr: vi.fn() };

    const status = await runCli(['run', '--plan', planPath], io, {
      cwd: repo.root,
      env: { LATCH_API_KEY: 'secret-value' },
      fetch: fetchMock,
    });

    expect(status).toBe(2);
    expect(io.stdout).not.toHaveBeenCalled();
    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('--profile'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gitStatus(repo)).toBe(before);
  });

  test('rejects a plan whose snapshot no longer matches the worktree', async () => {
    const repo = repositoryWithChange('correct');
    const planPath = planFile(repo, temporary());
    const profile = profileDirectory().write(
      'profile.json',
      profileContent(repo.root),
    );
    repo.write(
      'src/api.ts',
      `${readFileSync(join(repo.root, 'src/api.ts'), 'utf8')}\n// changed after plan\n`,
    );
    const fetchMock = vi.fn<typeof fetch>(async () => llmResponse());
    const io = { stdout: vi.fn(), stderr: vi.fn() };

    const status = await runCli(
      ['run', '--plan', planPath, '--profile', profile],
      io,
      {
        cwd: repo.root,
        env: { LATCH_API_KEY: 'secret-value' },
        fetch: fetchMock,
      },
    );

    expect(status).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(io.stderr).toHaveBeenCalledWith(
      expect.stringContaining('一致しません'),
    );
  });
});
