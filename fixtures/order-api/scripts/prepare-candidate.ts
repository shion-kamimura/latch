import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = [
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  'src',
  'test',
];

export class PrepareError extends Error {}

function copyEntries(source: string, target: string): void {
  for (const entry of ENTRIES) {
    const from = join(source, entry);
    if (!existsSync(from)) throw new PrepareError(`missing entry: ${entry}`);
    cpSync(from, join(target, entry), { recursive: true });
  }
}

const LINK_IGNORED = new Set([
  '.bin',
  '.modules.yaml',
  '.pnpm-store',
  '.pnpm-workspace-state-v1.json',
  '.vite',
  '.vite-temp',
  '.vitest-cache',
]);

function linkNodeModules(target: string): void {
  const require = createRequire(import.meta.url);
  const vitest = require.resolve('vitest');
  // vitest -> node_modules/.pnpm/.../node_modules/vitest
  const nodeModules = resolve(vitest, '..', '..');
  const linked = join(target, 'node_modules');
  mkdirSync(linked);
  for (const entry of readdirSync(nodeModules)) {
    if (LINK_IGNORED.has(entry)) continue;
    symlinkSync(resolve(nodeModules, entry), join(linked, entry));
  }
}

function applyPatch(
  target: string,
  patchPath: string,
  checkOnly: boolean,
): void {
  const result = spawnSync(
    'git',
    ['apply', ...(checkOnly ? ['--check'] : []), patchPath],
    {
      cwd: target,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  if (result.error)
    throw new PrepareError(`git apply failed: ${result.error.message}`);
  if (result.status !== 0)
    throw new PrepareError(`git apply rejected: ${result.stderr.trim()}`);
}

export interface PreparedCandidate {
  root: string;
  cleanup(): void;
}

export function prepareCandidate(change = 'base'): PreparedCandidate {
  const root = mkdtempSync(join(tmpdir(), 'latch-order-api-'));
  try {
    copyEntries(FIXTURE_ROOT, root);
    linkNodeModules(root);
    if (change !== 'base') {
      const known = new Set(
        readdirSync(join(FIXTURE_ROOT, 'changes')).map((name) =>
          name.replace(/\.patch$/u, ''),
        ),
      );
      const patch = join(FIXTURE_ROOT, 'changes', `${change}.patch`);
      if (!known.has(change) || !existsSync(patch)) {
        throw new PrepareError(`unknown change: ${change}`);
      }
      applyPatch(root, patch, false);
    }
    writeFileSync(
      join(root, 'REPRO.md'),
      [
        '# Prepared candidate',
        '',
        `change: ${change}`,
        '',
        'This directory is a copy without evaluation/. Do not copy evaluation/ into it.',
        'Run this script to prepare a separate evaluation copy that adds evaluation/.',
        'Send only this directory (not fixtures/order-api/evaluation) to Latch or an LLM.',
        '',
      ].join('\n'),
    );
    return {
      root,
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export interface SuiteResult {
  passed: boolean;
  detail: string;
}

export interface Suites {
  existing: SuiteResult;
  evaluation: SuiteResult;
}

function runSuite(root: string, config: string): SuiteResult {
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const result = spawnSync(
    process.execPath,
    [vitest, 'run', '--config', config],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  if (result.error)
    return { passed: false, detail: `spawn failed: ${result.error.message}` };
  const summary =
    /Tests\s+(.+)/u.exec(result.stdout)?.[1]?.trim() ?? 'no summary';
  return { passed: result.status === 0, detail: summary };
}

export function runEvaluation(root: string): SuiteResult {
  return runSuite(root, 'vitest.evaluation.config.ts');
}

export function runSuites(root: string): Suites {
  return {
    existing: runSuite(root, 'vitest.config.ts'),
    evaluation: runEvaluation(root),
  };
}

function main(argv: readonly string[]): number {
  const [change = 'base', rootTarget, keep = ''] = argv;
  let candidate: PreparedCandidate;
  try {
    candidate = prepareCandidate(change);
  } catch (error) {
    process.stderr.write(
      `prepare failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  let evaluationRoot: string | undefined;
  try {
    if (rootTarget) writeFileSync(resolve(rootTarget), `${candidate.root}\n`);
    evaluationRoot = mkdtempSync(join(tmpdir(), 'latch-order-api-evaluation-'));
    cpSync(candidate.root, evaluationRoot, {
      recursive: true,
      verbatimSymlinks: true,
    });
    cpSync(
      join(FIXTURE_ROOT, 'evaluation'),
      join(evaluationRoot, 'evaluation'),
      {
        recursive: true,
      },
    );
    cpSync(
      join(FIXTURE_ROOT, 'vitest.evaluation.config.ts'),
      join(evaluationRoot, 'vitest.evaluation.config.ts'),
    );
    const existing = runSuite(candidate.root, 'vitest.config.ts');
    const evaluation = runEvaluation(evaluationRoot);
    const suites: Suites = { existing, evaluation };
    process.stdout.write(
      [
        `candidate: ${candidate.root}`,
        `existing tests: ${suites.existing.passed ? 'passed' : 'failed'} (${suites.existing.detail})`,
        `evaluation tests: ${suites.evaluation.passed ? 'passed' : 'failed'} (${suites.evaluation.detail})`,
        '',
      ].join('\n'),
    );
    const expected = change === 'correct' ? true : false;
    return suites.existing.passed === expected &&
      suites.evaluation.passed === expected
      ? 0
      : 1;
  } finally {
    if (keep === '--keep')
      process.stderr.write(`prepared candidate kept: ${candidate.root}\n`);
    else candidate.cleanup();
    if (evaluationRoot)
      rmSync(evaluationRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
