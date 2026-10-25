import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { RequirementPlan } from '../../src/plan/types.js';
import type { RunReport } from '../../src/run/types.js';
import { createTemporaryDirectory, profileContent } from '../helpers/plan.js';
import {
  createTestRepository,
  type TestRepository,
} from '../helpers/repository.js';

const fixture = fileURLToPath(
  new URL('../../fixtures/order-api/', import.meta.url),
);
const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

// Authored from issue.md, independently of evaluation/cases.json. The mock never
// reads the oracle and is deliberately limited to one missing boundary scenario.
const generatedCode = `import { expect, test } from 'vitest';
import { calculateOrder } from '../../src/api.ts';
test('floors the discount', () => {
  expect(calculateOrder({
    lines: [{ sku: 'SKU-003', quantity: 1, unitPriceCents: 99 }],
    couponCode: 'SAVE10',
  })).toEqual({ ok: true, value: {
    subtotalCents: 99, totalCents: 90, appliedCoupon: 'SAVE10',
  }});
});
`;
const slowCode = `import { test } from 'vitest';
test('cannot finish within the budget', () => { while (true) {} });
`;

function fixedPlan(ambiguous: boolean) {
  const source = { kind: 'issue', line: 12 };
  const condition = {
    text: 'SAVE10 discount is floored to whole cents.',
    source,
    ambiguity: null,
    existingTestCandidateIds: [],
    missingScenarios: [
      {
        description: 'Apply SAVE10 to 99 cents.',
        rationale: 'Existing tests use divisible totals.',
      },
    ],
  };
  return {
    requirements: [
      {
        text: 'Coupon discounts are floored.',
        origin: 'issue-explicit',
        source,
        ambiguity: null,
        conditions: [
          condition,
          ...(ambiguous
            ? [
                {
                  text: 'Return a sufficiently fast response.',
                  source: { kind: 'issue', line: 20 },
                  ambiguity:
                    'No latency threshold or measurement environment is specified.',
                  existingTestCandidateIds: [],
                  missingScenarios: [],
                },
              ]
            : []),
        ],
      },
    ],
    unverified: [
      'All other Issue conditions remain outside this fixed-response evaluation.',
    ],
    notes: [],
  };
}

// Hash every worktree file, including untracked files and the index, rather than
// checking only git status (which would miss changes to already-dirty contents).
function fingerprint(repo: TestRepository) {
  function walk(path: string): string[] {
    return readdirSync(join(repo.root, path), { withFileTypes: true })
      .filter((entry) => entry.name !== '.git')
      .flatMap((entry) => {
        const name = join(path, entry.name);
        return entry.isDirectory()
          ? walk(name)
          : [`${name}:${sha(readFileSync(join(repo.root, name)))}`];
      });
  }
  return {
    files: walk('').sort(),
    index: sha(readFileSync(join(repo.root, '.git/index'))),
    head: repo.git(['rev-parse', 'HEAD']),
    status: repo.git([
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]),
  };
}

function run(args: string[], cwd: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd,
        env: {
          PATH: process.env.PATH,
          LANG: 'C',
          LATCH_API_KEY: 'evaluation-dummy-key',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    },
  );
}

test('evaluates the complete built CLI flow against a withheld oracle', async () => {
  const repo = createTestRepository();
  const output = createTemporaryDirectory();
  const requests: string[] = [];
  let mode = 'correct';
  let conditionId = '';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      requests.push(body);
      const generation = body.includes('You generate Vitest tests');
      const content = generation
        ? {
            tests: [
              {
                conditionId,
                name: 'floors the discount',
                rationale: 'Fractional discount boundary.',
                code: mode === 'impossible' ? slowCode : generatedCode,
              },
            ],
          }
        : fixedPlan(mode === 'ambiguous');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(content) } }],
        }),
      );
    });
  });
  const records: unknown[] = [];
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing mock address');
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    for (const path of [
      'package.json',
      'tsconfig.json',
      'vitest.config.ts',
      'src/api.ts',
      'test/existing.test.ts',
      'issue.md',
    ]) {
      repo.write(path, readFileSync(join(fixture, path)));
    }
    // Keep an oracle sentinel in a tracked, then modified, excluded path.
    repo.write(
      'evaluation/cases.json',
      '{"sentinel":"withheld-oracle-sentinel"}',
    );
    repo.commit('common evaluation base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.git(['update-ref', 'refs/remotes/origin/main', base]);
    repo.write(
      'evaluation/cases.json',
      '{"sentinel":"withheld-oracle-sentinel-dirty"}',
    );
    repo.write('untracked.txt', 'must remain unchanged');

    for (const current of ['correct', 'buggy', 'ambiguous', 'impossible']) {
      mode = current;
      const change = current === 'buggy' ? 'buggy' : 'correct';
      const patch = join(fixture, 'changes', `${change}.patch`);
      repo.git(['apply', patch]);
      if (mode === 'ambiguous')
        repo.write(
          'issue.md',
          `${readFileSync(join(fixture, 'issue.md'), 'utf8')}\n- Return a sufficiently fast response.\n`,
        );
      const before = fingerprint(repo);
      expect(fingerprint(repo), 'fingerprint itself').toEqual(before);
      const start = performance.now();
      const requestStart = requests.length;
      const profile = join(output.root, 'profile.json');
      writeFileSync(
        profile,
        profileContent(repo.root, {
          allowedEndpoint: endpoint,
          connectionEndpoint: endpoint,
          model: 'fixed-order-api-v1',
          limits: { maxRequests: 1 },
          extra: {
            execution: {
              limits: {
                timeoutMs: mode === 'impossible' ? 1_000 : 15_000,
                maxRepairAttempts: 0,
              },
            },
          },
        }),
      );
      const planned = await run(
        [
          'plan',
          '--base',
          'origin/main',
          '--issue-file',
          'issue.md',
          '--profile',
          profile,
          '--json',
        ],
        repo.root,
      );
      expect(planned.status, planned.stderr).toBe(0);
      expect(fingerprint(repo), 'after plan').toEqual(before);
      const plan = JSON.parse(planned.stdout) as RequirementPlan;
      expect(plan.llm.model).toBe('fixed-order-api-v1');
      expect(plan.input.base.commit).toBe(base);
      expect(plan.testCandidates.length).toBeGreaterThan(0);
      conditionId = plan.requirements[0]!.conditions[0]!.id;
      const planPath = join(output.root, 'plan.json');
      writeFileSync(planPath, planned.stdout);
      const args = ['run', '--plan', planPath, '--profile', profile];
      const json = await run([...args, '--json'], repo.root);
      expect(fingerprint(repo), 'after JSON run').toEqual(before);
      const text = await run(args, repo.root);
      const expectedExit = mode === 'impossible' ? 2 : 0;
      expect(json.status, json.stderr).toBe(expectedExit);
      expect(text.status, text.stderr).toBe(expectedExit);
      const report = JSON.parse(json.stdout) as RunReport;
      const expected =
        mode === 'buggy'
          ? 'failed'
          : mode === 'impossible'
            ? 'execution-impossible'
            : 'verified';
      expect(report.conditions[0]?.state).toBe(expected);
      const evidence = report.evidence.filter((entry) =>
        report.conditions[0]!.evidenceIds.includes(entry.id),
      );
      expect(evidence).toContainEqual(
        expect.objectContaining({
          kind: 'generated',
          conditionIds: [conditionId],
          content: mode === 'impossible' ? slowCode : generatedCode,
          status:
            mode === 'buggy'
              ? 'assertion-failed'
              : mode === 'impossible'
                ? 'timeout'
                : 'passed',
        }),
      );
      if (mode !== 'impossible') {
        const existing = report.evidence.filter(
          (entry) => entry.kind === 'existing',
        );
        expect(existing.length).toBeGreaterThan(0);
        expect(existing.every((entry) => entry.status === 'passed')).toBe(true);
      }
      if (mode === 'ambiguous') {
        expect(report.conditions[1]?.state).toBe('ambiguous');
        expect(report.conditions[1]?.evidenceIds).toEqual([]);
        expect(report.requirements[0]?.state).toBe('ambiguous');
        expect(text.stdout).toContain('要件不明確');
      }
      expect(text.stdout).toContain(conditionId);
      expect(text.stdout).toContain(evidence[0]!.id);
      expect(text.stdout).toContain(
        mode === 'buggy'
          ? '検証失敗'
          : mode === 'impossible'
            ? '実行不能・判定不能'
            : '検証成功',
      );
      expect(report.isolation.cleanup.status).toBe('removed');
      expect(fingerprint(repo)).toEqual(before);
      expect(requests.length - requestStart).toBe(3); // plan + JSON run + text run
      expect(requests.join('\n')).not.toContain('withheld-oracle-sentinel');
      expect(JSON.stringify({ report, text })).not.toContain(
        'evaluation-dummy-key',
      );
      records.push({
        case: mode,
        expected,
        actual: report.conditions[0]?.state,
        conditions: report.conditions.map(
          ({ conditionId, state, evidenceIds }) => ({
            conditionId,
            state,
            evidenceIds,
          }),
        ),
        evidence: report.evidence.map(
          ({
            id,
            kind,
            status,
            conditionIds,
            exitCode,
            durationMs,
            content,
          }) => ({
            id,
            kind,
            status,
            conditionIds,
            exitCode,
            durationMs,
            contentDigest: content === null ? null : sha(content),
          }),
        ),
        jsonExitCode: json.status,
        textExitCode: text.status,
        generation: report.generation,
        ambiguity: mode === 'ambiguous' ? report.conditions[1]?.state : null,
        base,
        issueDigest: report.input.issue.digest,
        diffDigest: report.input.diff.digest,
        snapshotDigest: report.input.snapshotDigest,
        requests: requests.length - requestStart,
        elapsedMs: Math.round(performance.now() - start),
        worktreeUnchanged: true,
      });
      repo.git(['apply', '-R', patch]);
      repo.write('issue.md', readFileSync(join(fixture, 'issue.md')));
    }
    // Read the independent truth only after all planning and generation calls.
    const oracle = JSON.parse(
      readFileSync(join(fixture, 'evaluation/cases.json'), 'utf8'),
    ) as {
      cases: { id: string; expected: { body: unknown } }[];
    };
    expect(
      oracle.cases.find((entry) => entry.id === 'boundary.fractional-cents')
        ?.expected.body,
    ).toEqual({ subtotalCents: 99, totalCents: 90, appliedCoupon: 'SAVE10' });
    const record = {
      mode: 'fixed-response-regression',
      model: 'fixed-order-api-v1',
      at: new Date().toISOString(),
      node: process.version,
      trialsPerCase: 1,
      usage:
        'No real API calls; token usage is not supplied by the mock; cost USD 0.',
      records,
      fixtureHashes: Object.fromEntries(
        [
          'issue.md',
          'src/api.ts',
          'changes/correct.patch',
          'changes/buggy.patch',
        ].map((path) => [path, sha(readFileSync(join(fixture, path)))]),
      ),
      settings: {
        maxRequestsPerCommand: 1,
        maxRepairAttempts: 0,
        executionTimeoutMs: { normal: 15000, impossible: 1000 },
        dependencyMode: 'runner',
        network: 'blocked',
      },
    };
    if (process.env.LATCH_EVALUATION_RECORD)
      writeFileSync(
        process.env.LATCH_EVALUATION_RECORD,
        `${JSON.stringify(record, null, 2)}\n`,
      );
    console.log(JSON.stringify(record));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    repo.cleanup();
    output.cleanup();
  }
}, 120_000);
