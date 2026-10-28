import { createFakeCli } from '../helpers/official-cli.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { discoverVitestCandidates } from '../../src/plan/test-candidates.js';
import { resolveVerificationInputs } from '../../src/verify/resolve-inputs.js';
import { createProfileDirectory, profileContent } from '../helpers/plan.js';
import {
  createTestRepository,
  type TestRepository,
} from '../helpers/repository.js';

const unmanagedHost = fileURLToPath(
  new URL('../helpers/unmanaged-host.mjs', import.meta.url),
);
const cliPath = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

test('built CLI prints help and exits successfully', () => {
  const result = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: latch [options]');
  expect(result.stdout).toContain('--help');
  expect(result.stdout).toContain('-v, --version');
  expect(result.stderr).toBe('');
});

test.each(['--version', '-v'])(
  'built CLI prints the package version for %s',
  (flag) => {
    const result = spawnSync(process.execPath, [cliPath, flag], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${packageJson.version}\n`);
    expect(result.stderr).toBe('');
  },
);

const repositories: TestRepository[] = [];
const directories: { cleanup(): void }[] = [];

const fixtureRoot = fileURLToPath(
  new URL('../../fixtures/order-api', import.meta.url),
);

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

function temporaryDirectory(): { readonly root: string; cleanup(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'latch-e2e-run-'));
  const entry = {
    root: directory,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
  directories.push(entry);
  return entry;
}

function orderRepository(): TestRepository {
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
    repo.write(path, readFileSync(join(fixtureRoot, path)));
  }
  repo.commit('fixture base');
  repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  repo.git(['apply', join(fixtureRoot, 'changes', 'correct.patch')]);
  repo.commit('apply correct change');
  return repo;
}

function runPlanFile(repo: TestRepository): string {
  const directory = temporaryDirectory();
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
  const path = join(directory.root, 'plan.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
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
                    rationale:
                      'Existing tests only use amounts divisible by 10.',
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
      },
      null,
      2,
    ),
  );
  return path;
}

function runBuiltAsync(
  args: string[],
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', unmanagedHost, cliPath, ...args],
      {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({ status: null, signal: null, stdout, stderr, error });
    });
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

const SLOW_GENERATED_CODE = [
  "import { test } from 'vitest';",
  '',
  "test('exceeds the execution budget', () => {",
  '  const started = Date.now();',
  '  while (Date.now() - started < 5_000) {}',
  '});',
  '',
].join('\n');

function fixedCli(code = GENERATED_CODE) {
  const directory = createProfileDirectory();
  directories.push(directory);
  const cli = createFakeCli(directory.root);
  cli.configure({
    response: {
      tests: [
        {
          conditionId: 'cond-discount-floor',
          name: 'floors fractional discount cents',
          rationale: 'fixed output',
          code,
        },
      ],
    },
  });
  return cli;
}

function repository(): TestRepository {
  const repo = createTestRepository();
  repositories.push(repo);
  repo.write('issue.md', '# CLI issue\n\n- a requirement\n');
  repo.commit('add issue');
  repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return repo;
}

function runBuilt(args: string[], root: string) {
  return spawnSync(
    process.execPath,
    ['--import', unmanagedHost, cliPath, ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.cleanup();
  for (const directory of directories.splice(0)) directory.cleanup();
});

test('built CLI resolves inputs as JSON without claiming verification', () => {
  const repo = repository();
  repo.write('src/a.ts', 'export const value = 2;\n');
  repo.commit('change value');

  const result = runBuilt(
    ['verify', '--base', 'origin/main', '--issue-file', 'issue.md', '--json'],
    repo.root,
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const snapshot = JSON.parse(result.stdout) as {
    phase: string;
    verification: string;
  };
  expect(snapshot.phase).toBe('input-resolution');
  expect(snapshot.verification).toBe('not-run');
  expect(result.stdout).not.toContain('検証成功');
});

test('built CLI includes an explicitly named untracked file', () => {
  const repo = repository();
  repo.write('src/new.ts', 'export const added = true;\n');

  const result = runBuilt(
    [
      'verify',
      '--base',
      'origin/main',
      '--issue-file',
      'issue.md',
      '--include-untracked',
      'src/new.ts',
      '--json',
    ],
    repo.root,
  );

  expect(result.status).toBe(0);
  const snapshot = JSON.parse(result.stdout) as {
    diff: { untracked: { path: string }[]; files: unknown[] };
  };
  expect(snapshot.diff.untracked.map((file) => file.path)).toEqual([
    'src/new.ts',
  ]);
  expect(result.stderr).toBe('');
});

test('built CLI warns and fails when only untracked changes exist', () => {
  const repo = repository();
  repo.write('src/untracked.ts', 'export const untracked = true;\n');

  const result = runBuilt(
    ['verify', '--base', 'origin/main', '--issue-file', 'issue.md'],
    repo.root,
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('未追跡ファイル');
  expect(result.stderr).toContain('--include-untracked');
  expect(result.stderr).toContain('差分が空');
  expect(result.stderr).not.toContain('export const untracked');
});

test('built CLI plan fails closed without a permission profile', () => {
  const repo = repository();
  repo.write('src/a.ts', 'export const value = 2;\n');
  repo.commit('change value');

  const result = runBuilt(
    ['plan', '--base', 'origin/main', '--issue-file', 'issue.md'],
    repo.root,
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('--profile');
  expect(result.stderr).toContain('LATCH_PROFILE');
});

test('built CLI returns exit code 1 outside a repository', () => {
  const directory = mkdtempSync(join(tmpdir(), 'latch-not-a-repository-'));
  try {
    const result = runBuilt(['verify', '--issue-file', 'issue.md'], directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Git管理されたリポジトリ');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('built CLI run prints a schema-valid verification report as JSON', async () => {
  const repo = orderRepository();
  const planPath = runPlanFile(repo);
  const mockCli = fixedCli();
  const profileDirectory = createProfileDirectory();
  directories.push(profileDirectory);
  const profile = profileDirectory.write(
    'profile.json',
    profileContent(repo.root, {}),
  );

  const result = await runBuiltAsync(
    ['run', '--plan', planPath, '--profile', profile, '--json'],
    repo.root,
    {
      PATH: mockCli.env.PATH ?? '',
      HOME: mockCli.env.HOME,
      LANG: process.env.LANG ?? 'C',
      LATCH_API_KEY: 'secret-value',
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('secret-value');
  expect(result.stdout).not.toContain('secret-value');
  const report = JSON.parse(result.stdout) as {
    schemaVersion: string;
    verification: string;
    input: {
      diff: { kinds: { committed: number } };
      issue: { input: string; source: string };
    };
    requirements: { requirementId: string; state: string }[];
    conditions: {
      conditionId: string;
      state: string;
      evidenceIds: string[];
    }[];
    evidence: { id: string; status: string }[];
    disclaimer: string;
  };
  expect(report.schemaVersion).toBe('1');
  expect(report.verification).toBe('completed');
  expect(report.input.diff.kinds.committed).toBeGreaterThan(0);
  expect(report.input.issue).toMatchObject({
    input: 'issue-file',
    source: 'issue.md',
  });
  expect(report.requirements).toContainEqual(
    expect.objectContaining({
      requirementId: 'req-discount',
      state: 'verified',
    }),
  );
  expect(report.conditions[0]).toMatchObject({
    conditionId: 'cond-discount-floor',
    state: 'verified',
  });
  const evidenceId = report.conditions[0]?.evidenceIds[0];
  expect(report.evidence.find((item) => item.id === evidenceId)?.status).toBe(
    'passed',
  );
  expect(report.disclaimer).toContain('正しさの証明ではありません');
}, 30_000);

test('built CLI run prints a partial report and exits 2 when execution is impossible', async () => {
  const repo = orderRepository();
  const planPath = runPlanFile(repo);
  const mockCli = fixedCli(SLOW_GENERATED_CODE);
  const profileDirectory = createProfileDirectory();
  directories.push(profileDirectory);
  const profile = profileDirectory.write(
    'profile.json',
    profileContent(repo.root, {
      extra: {
        execution: {
          dependencies: { mode: 'runner', registry: null },
          network: { allowedDestinations: [] },
          limits: { timeoutMs: 1_000 },
        },
      },
    }),
  );

  const result = await runBuiltAsync(
    ['run', '--plan', planPath, '--profile', profile, '--json'],
    repo.root,
    {
      PATH: mockCli.env.PATH ?? '',
      HOME: mockCli.env.HOME,
      LANG: process.env.LANG ?? 'C',
      LATCH_API_KEY: 'secret-value',
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).not.toContain('secret-value');
  const report = JSON.parse(result.stdout) as {
    verification: string;
    partialReasons: string[];
    conditions: { state: string }[];
    evidence: { kind: string; status: string }[];
  };
  expect(report.verification).toBe('partial');
  expect(report.partialReasons.length).toBeGreaterThan(0);
  expect(report.conditions[0]?.state).toBe('execution-impossible');
  expect(
    report.evidence.find((item) => item.kind === 'generated')?.status,
  ).toBe('timeout');
  expect(result.stderr).toContain('時間上限');
}, 30_000);

test('built CLI run reports invalid plan input with exit code 1 and no report', () => {
  const repo = repository();
  const directory = temporaryDirectory();
  const planPath = join(directory.root, 'broken-plan.json');
  writeFileSync(planPath, '{"phase":"wrong"}');

  const result = runBuilt(['run', '--plan', planPath], repo.root);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('計画ファイル');
});
