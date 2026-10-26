import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultExecutionSettings } from '../../src/plan/profile.js';
import type { ExecutionSettings } from '../../src/plan/types.js';
import { executeSuite } from '../../src/run/execute.js';
import type { IsolationWorkspace } from '../../src/run/types.js';

const roots: string[] = [];

function workspaceWithRunner(script: string | null): IsolationWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'latch-execute-test-'));
  roots.push(root);
  const workDir = join(root, 'repo');
  mkdirSync(join(workDir, 'tests'), { recursive: true });
  writeFileSync(join(workDir, 'tests', 'sample.test.ts'), '// sample\n');
  const runnerPath = join(root, 'runner.mjs');
  if (script !== null) writeFileSync(runnerPath, script);
  return {
    root,
    workDir,
    runnerPath,
    runnerNodeModules: join(process.cwd(), 'node_modules'),
    copiedFiles: 1,
    excluded: [],
    dependencyMode: 'runner',
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      return { status: 'removed', note: 'removed' };
    },
  };
}

function settingsWithTimeout(timeoutMs: number): ExecutionSettings {
  const base = defaultExecutionSettings();
  return {
    ...base,
    limits: { ...base.limits, timeoutMs, maxOutputBytes: 10_000 },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('isolated suite execution', () => {
  test('does not pass official CLI credentials or HOME to generated tests', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'do-not-inherit');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'do-not-inherit');
    vi.stubEnv('LATCH_API_KEY', 'do-not-inherit');
    try {
      const workspace = workspaceWithRunner(null);
      writeFileSync(
        workspace.runnerPath,
        `
        if (['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','LATCH_API_KEY'].some(key => process.env[key] !== undefined) || process.env.HOME !== ${JSON.stringify(join(workspace.root, 'home'))}) console.log('CREDENTIAL_LEAK');
        else console.log('CREDENTIALS_NOT_FORWARDED');
      `,
      );
      const result = executeSuite({
        workspace,
        settings: settingsWithTimeout(1000),
        include: ['tests/sample.test.ts'],
        name: 'credential-check',
        kind: 'generated',
        conditionIdsByTest: () => [],
      });
      expect(result.evidence[0]?.log).toContain('CREDENTIALS_NOT_FORWARDED');
      expect(result.evidence[0]?.log).not.toContain('CREDENTIAL_LEAK');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('kills the child process at the time limit and records a timeout', () => {
    const workspace = workspaceWithRunner('setTimeout(() => {}, 10_000);\n');
    const result = executeSuite({
      workspace,
      settings: settingsWithTimeout(1_000),
      include: ['tests/sample.test.ts'],
      name: 'timeout',
      kind: 'generated',
      conditionIdsByTest: () => ['cond-timeout'],
    });

    expect(result.status).toBe('timeout');
    expect(result.setupFailure).toBe(true);
    expect(result.evidence[0]?.status).toBe('timeout');
    expect(result.evidence[0]?.conditionIds).toEqual(['cond-timeout']);
    expect(result.evidence[0]?.log).toContain('時間上限');
  });

  test('blocks child processes and network from generated tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'latch-execute-block-'));
    roots.push(root);
    const workDir = join(root, 'repo');
    mkdirSync(join(workDir, '.latch', 'generated'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(
      join(workDir, '.latch', 'generated', 'blocked.test.ts'),
      [
        "import { expect, test } from 'vitest';",
        "import { spawnSync } from 'node:child_process';",
        '',
        "test('child_process is blocked', () => {",
        "  expect(() => spawnSync(process.execPath, ['-e', '1'])).toThrow(",
        '    /Latch isolation blocked/',
        '  );',
        '});',
        '',
        "test('fetch is blocked', async () => {",
        "  await expect(async () => fetch('https://example.com')).rejects.toThrow(",
        '    /Latch isolation blocked/',
        '  );',
        '});',
        '',
      ].join('\n'),
    );
    const require = createRequire(import.meta.url);
    const packageRoot = join(require.resolve('vitest/package.json'), '..');
    const workspace: IsolationWorkspace = {
      root,
      workDir,
      runnerPath: join(packageRoot, 'vitest.mjs'),
      runnerNodeModules: join(process.cwd(), 'node_modules'),
      copiedFiles: 2,
      excluded: [],
      dependencyMode: 'runner',
      cleanup() {
        rmSync(root, { recursive: true, force: true });
        return { status: 'removed', note: 'removed' };
      },
    };

    const result = executeSuite({
      workspace,
      settings: settingsWithTimeout(10_000),
      include: ['.latch/generated/blocked.test.ts'],
      name: 'blocked',
      kind: 'generated',
      conditionIdsByTest: () => ['cond-blocked'],
    });

    expect(result.status).toBe('passed');
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.every((item) => item.status === 'passed')).toBe(
      true,
    );
  });

  test('distinguishes a runner startup failure from an assertion failure', () => {
    const workspace = workspaceWithRunner(null);
    const result = executeSuite({
      workspace,
      settings: settingsWithTimeout(5_000),
      include: ['tests/sample.test.ts'],
      name: 'startup',
      kind: 'generated',
      conditionIdsByTest: () => ['cond-startup'],
    });

    expect(result.status).toBe('runner-startup-failed');
    expect(result.setupFailure).toBe(true);
    expect(result.evidence[0]?.status).toBe('runner-startup-failed');
  });
});
