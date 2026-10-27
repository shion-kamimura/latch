import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import type { PlanningCli } from '../../src/plan/llm.js';
import { planRequirements } from '../../src/plan/plan.js';
import { runVerification } from '../../src/run/run.js';
import { readSourceManifest } from '../../src/plan/source-files.js';
import { createTestRepository } from '../helpers/repository.js';
import { createProfileDirectory, profileContent } from '../helpers/plan.js';

const fixtureRoot = fileURLToPath(
  new URL('../../fixtures/order-api', import.meta.url),
);
const cleanup: (() => void)[] = [];
const options = {
  base: 'origin/main',
  issueFile: 'issue.md',
  includeUntracked: [],
  json: false,
};
const selected = ['src/api.ts', 'src/server.ts'];

function setup(change: 'correct' | 'buggy' = 'correct') {
  const repo = createTestRepository();
  const directory = createProfileDirectory();
  cleanup.push(
    () => repo.cleanup(),
    () => directory.cleanup(),
  );
  for (const path of [
    'package.json',
    'tsconfig.json',
    'vitest.config.ts',
    ...selected,
    'issue.md',
  ]) {
    repo.write(path, readFileSync(join(fixtureRoot, path)));
  }
  repo.write('src/private.ts', '// UNSELECTED_SOURCE_SENTINEL');
  repo.write('evaluation/oracle.ts', '// ORACLE_SOURCE_SENTINEL');
  repo.commit('fixture');
  repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  repo.git(['apply', join(fixtureRoot, 'changes', `${change}.patch`)]);
  const profile = (
    sourceFiles = selected,
    dataCategories = ['issue', 'diff', 'tests', 'source'],
  ) =>
    directory.write(
      'profile.json',
      profileContent(repo.root, { sourceFiles, dataCategories }),
    );
  return { repo, directory, profile };
}

// Fixed CLI responses exercise the input contract, not real-model quality.
const planned = {
  requirements: [
    {
      text: 'Discounts are floored to whole cents.',
      origin: 'issue-explicit',
      source: { kind: 'issue', line: 12 },
      ambiguity: null,
      conditions: [
        {
          text: '99 cents with SAVE10 totals 90 cents through the HTTP handler.',
          source: { kind: 'issue', line: 12 },
          ambiguity: null,
          existingTestCandidateIds: [],
          missingScenarios: [
            {
              description:
                'Use structural request/response objects without listening on a port.',
              rationale: 'Verify the HTTP result with a fractional discount.',
            },
          ],
        },
      ],
    },
  ],
};

const code = `import { expect, test } from 'vitest';
import { handleRequest } from '../../src/api.ts';
import { createApp } from '../../src/server.ts';
test('handles an iterable body through the actual interface', async () => {
  const req = { method: 'POST', url: '/orders/total', async *[Symbol.asyncIterator]() {
    yield JSON.stringify({ lines: [{ sku: 'SKU-003', quantity: 1, unitPriceCents: 99 }], couponCode: 'SAVE10' });
  }};
  let body = '';
  const res = { statusCode: 0, setHeader() {}, end(value: string) { body = value; } };
  await handleRequest(req, res);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(body)).toEqual({ subtotalCents: 99, totalCents: 90, appliedCoupon: 'SAVE10' });
});
test('initializes the server through its exported factory without listening', () => {
  const server = createApp();
  expect(server.listenerCount('request')).toBe(1);
  expect(server.listening).toBe(false);
});
`;

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

test.each(['correct', 'buggy'] as const)(
  'pins selected interfaces through plan, generation and repair (%s)',
  async (change) => {
    const { repo, directory, profile } = setup(change);
    const profilePath = profile();
    const prompts: { system: string; user: string }[] = [];
    const invokePlan = vi.fn<PlanningCli>(async (input) => {
      prompts.push(input);
      return JSON.stringify(planned);
    });
    const plan = await planRequirements(
      { ...options, profile: profilePath },
      { cwd: repo.root, env: {}, invokeCli: invokePlan },
    );
    expect(plan.input.sourceFiles?.map((file) => file.path)).toEqual(selected);
    expect(plan.permission.dataCategories).toContain('source');
    expect(JSON.stringify(plan)).not.toContain('export function createApp');
    const path = directory.write('plan.json', JSON.stringify(plan));
    const conditionId = plan.requirements[0]!.conditions[0]!.id;
    let attempts = 0;
    const invokeRun = vi.fn<PlanningCli>(async (input) => {
      prompts.push(input);
      attempts += 1;
      return JSON.stringify({
        tests: [
          {
            conditionId,
            name: 'HTTP contract',
            rationale: 'Issue expectations with actual interfaces',
            code:
              attempts === 1
                ? "import { test } from 'vitest'; test('broken', () => {"
                : code,
          },
        ],
      });
    });
    const report = await runVerification(
      { plan: path, profile: profilePath, json: true },
      { cwd: repo.root, env: {}, invokeCli: invokeRun },
    );
    expect(report.verification).toBe('completed');
    expect(report.generation.repairAttempts).toBe(1);
    expect(report.input.sourceFiles).toEqual(plan.input.sourceFiles);
    expect(
      report.evidence.filter((item) => item.status === 'assertion-failed'),
    ).toHaveLength(change === 'buggy' ? 1 : 0);
    expect(
      report.evidence.some(
        (item) =>
          item.testName.includes('exported factory') &&
          item.status === 'passed',
      ),
    ).toBe(true);
    expect(report.conditions[0]?.state).toBe(
      change === 'correct' ? 'verified' : 'failed',
    );
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt.user).toContain('Symbol.asyncIterator');
      expect(prompt.user).toContain('export function createApp');
      expect(prompt.user).not.toContain('UNSELECTED_SOURCE_SENTINEL');
      expect(prompt.user).not.toContain('ORACLE_SOURCE_SENTINEL');
      expect(prompt.system).toContain('untrusted');
      expect(prompt.system).toContain('implementation results');
    }
  },
  15_000,
);

test('keeps source opt-in and requires a new plan after adding source permission', async () => {
  const { repo, directory, profile } = setup();
  const profilePath = profile([]);
  const invokeCli = vi.fn<PlanningCli>(async (input) => {
    expect(input.user).not.toContain('export function createApp');
    return JSON.stringify(planned);
  });
  const plan = await planRequirements(
    { ...options, profile: profilePath },
    { cwd: repo.root, env: {}, invokeCli },
  );
  expect(plan.input.sourceFiles).toEqual([]);
  const path = directory.write('plan.json', JSON.stringify(plan));
  profile();
  invokeCli.mockClear();
  await expect(
    runVerification(
      { plan: path, profile: profilePath, json: true },
      { cwd: repo.root, env: {}, invokeCli },
    ),
  ).rejects.toThrow('許可範囲が一致しません');
  expect(invokeCli).not.toHaveBeenCalled();
});

test.each([
  'selection',
  'manifest',
  'digest',
  'content',
  'revocation',
] as const)('rejects changed %s before calling the CLI', async (kind) => {
  const { repo, directory, profile } = setup();
  const profilePath = profile();
  const plan = await planRequirements(
    { ...options, profile: profilePath },
    {
      cwd: repo.root,
      env: {},
      invokeCli: async () => JSON.stringify(planned),
    },
  );
  if (kind === 'selection') profile(['src/api.ts']);
  const saved =
    kind === 'manifest'
      ? { ...plan, input: { ...plan.input, sourceFiles: undefined } }
      : plan;
  if (kind === 'digest')
    Object.assign(saved.input, {
      sourceFiles: plan.input.sourceFiles!.map((file) => ({
        ...file,
        digest: '0'.repeat(64),
      })),
    });
  if (kind === 'content') repo.write('src/server.ts', '// changed interface');
  if (kind === 'revocation')
    directory.write(
      'profile.json',
      profileContent(repo.root, {
        sourceFiles: selected,
        dataCategories: ['issue', 'diff', 'tests', 'source'],
        decision: 'revoked',
      }),
    );
  const path = directory.write('plan.json', JSON.stringify(saved));
  const invokeCli = vi.fn<PlanningCli>();
  await expect(
    runVerification(
      { plan: path, profile: profilePath, json: true },
      { cwd: repo.root, env: {}, invokeCli },
    ),
  ).rejects.toThrow();
  expect(invokeCli).not.toHaveBeenCalled();
});

test.each([
  '../outside.ts',
  '/tmp/outside.ts',
  'src/*.ts',
  '.codex/config.ts',
  'evaluation/oracle.ts',
  'dist/index.js',
  'src',
  'src/link.ts',
  'src/alias/api.ts',
  'src/binary.ts',
  'src/untracked.ts',
])('does not send disallowed source %s', async (path) => {
  const { repo, profile } = setup();
  repo.symlink(join(repo.root, 'src/api.ts'), 'src/link.ts');
  repo.symlink(join(repo.root, 'src'), 'src/alias');
  repo.write('src/binary.ts', Buffer.from([0xff, 0x00]));
  repo.git(['add', 'src/binary.ts']);
  repo.git(['commit', '-qm', 'binary input']);
  repo.write('src/untracked.ts', '// untracked');
  const profilePath = profile([path]);
  const invokeCli = vi.fn<PlanningCli>();
  await expect(
    planRequirements(
      { ...options, profile: profilePath },
      { cwd: repo.root, env: {}, invokeCli },
    ),
  ).rejects.toThrow();
  expect(invokeCli).not.toHaveBeenCalled();
});

test('requires the source category independently of the file selection', async () => {
  const { repo, profile } = setup();
  const invokeCli = vi.fn<PlanningCli>();
  await expect(
    planRequirements(
      { ...options, profile: profile(selected, ['issue', 'diff', 'tests']) },
      { cwd: repo.root, env: {}, invokeCli },
    ),
  ).rejects.toThrow('送信許可がありません');
  expect(invokeCli).not.toHaveBeenCalled();
});

test('binds explicitly included untracked source and rejects malformed manifests', async () => {
  const { repo, profile } = setup();
  repo.write('src/new.ts', 'export const newInterface = true;');
  const plan = await planRequirements(
    {
      ...options,
      includeUntracked: ['src/new.ts'],
      profile: profile(['src/new.ts']),
    },
    { cwd: repo.root, env: {}, invokeCli: async () => JSON.stringify(planned) },
  );
  expect(plan.input.sourceFiles?.[0]?.path).toBe('src/new.ts');
  expect(() =>
    readSourceManifest([{ path: '../escape.ts', digest: 'a'.repeat(64) }]),
  ).toThrow();
  expect(() =>
    readSourceManifest([{ path: 'src/new.ts', digest: 'bad' }]),
  ).toThrow();
  expect(() =>
    readSourceManifest([
      plan.input.sourceFiles![0],
      plan.input.sourceFiles![0],
    ]),
  ).toThrow();
});
