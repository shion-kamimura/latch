import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// A fixed-input regression comparison, not a model or agent benchmark.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (
    !key ||
    !['--baseline', '--trials', '--output'].includes(key) ||
    !value ||
    options.has(key)
  ) {
    throw new Error(
      '指定方法: --baseline <40桁SHA> --trials <1〜10> --output <新規JSON>',
    );
  }
  options.set(key, value);
}
const baseline = options.get('--baseline') ?? '';
const trials = Number(options.get('--trials') ?? '3');
const output = options.get('--output');
if (
  !/^[a-f0-9]{40}$/.test(baseline) ||
  !Number.isInteger(trials) ||
  trials < 1 ||
  trials > 10 ||
  !output
) {
  throw new Error(
    'baselineは40桁SHA、trialsは1〜10、outputは新規ファイルを指定してください。',
  );
}
const manifest = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
) as { packageManager: string };
const pnpmVersion = manifest.packageManager.replace(/^pnpm@/, '');
if (!/^\d+\.\d+\.\d+$/.test(pnpmVersion))
  throw new Error('packageManagerの版が不正です。');
const nodeVersion = readFileSync(join(root, '.node-version'), 'utf8');
const git = (args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sources = {
  baseline: git(['show', `${baseline}:scripts/check-environment.ts`]),
  current: readFileSync(join(root, 'scripts/check-environment.ts'), 'utf8'),
};
const cases = [
  'ready',
  'missing-node-version',
  'invalid-node-version',
  'node-version-directory',
  'lockfile-directory',
  'missing-pnpm',
  'missing-dependency',
] as const;
const runs: {
  version: string;
  case: string;
  trial: number;
  passed: boolean;
  inconclusive: boolean;
  exitCode: number | null;
  durationMs: number;
  failures: string[];
}[] = [];
const workspace = mkdtempSync(join(tmpdir(), 'latch-env-eval-'));
const startedAt = new Date().toISOString();
try {
  for (const [version, source] of Object.entries(sources)) {
    for (const scenario of cases) {
      for (let trial = 1; trial <= trials; trial++) {
        const directory = join(workspace, `${version}-${scenario}-${trial}`);
        mkdirSync(join(directory, 'scripts'), { recursive: true });
        mkdirSync(join(directory, 'bin'));
        writeFileSync(join(directory, 'scripts/check-environment.ts'), source);
        writeFileSync(
          join(directory, 'package.json'),
          JSON.stringify({
            type: 'module',
            packageManager: manifest.packageManager,
            devDependencies:
              scenario === 'missing-dependency'
                ? { 'latch-eval-missing-dependency': '0.0.0' }
                : {},
          }),
        );
        if (scenario === 'node-version-directory')
          mkdirSync(join(directory, '.node-version'));
        else if (scenario !== 'missing-node-version')
          writeFileSync(
            join(directory, '.node-version'),
            scenario === 'invalid-node-version' ? 'invalid' : nodeVersion,
          );
        if (scenario === 'lockfile-directory')
          mkdirSync(join(directory, 'pnpm-lock.yaml'));
        else
          writeFileSync(
            join(directory, 'pnpm-lock.yaml'),
            'lockfileVersion: 9.0\n',
          );
        if (scenario !== 'missing-pnpm')
          writeFileSync(
            join(directory, 'bin/pnpm'),
            `#!/bin/sh\nprintf '%s\\n' '${pnpmVersion}'\n`,
            { mode: 0o755 },
          );
        const start = performance.now();
        const result = spawnSync(
          process.execPath,
          [join(directory, 'scripts/check-environment.ts')],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 15_000,
            env: {
              PATH: join(directory, 'bin'),
              HOME: directory,
              LANG: 'C.UTF-8',
            },
          },
        );
        const failures: string[] = [];
        if (result.error || result.signal) failures.push('process-error');
        if (result.status !== (scenario === 'ready' ? 0 : 1))
          failures.push('exit-code');
        if (result.stderr) failures.push('unexpected-stderr');
        if (
          scenario === 'ready' &&
          !result.stdout.includes('準備項目を確認しました')
        ) {
          failures.push('missing-ready');
        }
        if (
          scenario !== 'ready' &&
          result.stdout.includes('準備項目を確認しました')
        )
          failures.push('false-ready');
        if (
          scenario.includes('node-version') &&
          !result.stdout.includes('.node-version')
        )
          failures.push('missing-remediation');
        if (result.stdout.includes('invalid.x'))
          failures.push('invalid-version-guidance');
        runs.push({
          version,
          case: scenario,
          trial,
          passed: failures.length === 0,
          inconclusive: Boolean(result.error || result.signal),
          exitCode: result.status,
          durationMs: Math.round(performance.now() - start),
          failures,
        });
      }
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
const summary = Object.keys(sources).map((version) => {
  const subset = runs.filter((run) => run.version === version);
  return {
    version,
    passed: subset.filter((run) => run.passed).length,
    total: subset.length,
    inconclusive: subset.filter((run) => run.inconclusive).length,
  };
});
writeFileSync(
  output,
  JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'environment-regression',
      startedAt,
      baseline,
      currentHead: git(['rev-parse', 'HEAD']),
      currentScript: execFileSync(
        'git',
        ['hash-object', '--', 'scripts/check-environment.ts'],
        { cwd: root, encoding: 'utf8' },
      ).trim(),
      environment: {
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      model: null,
      additionalInterventions: null,
      llmCost: null,
      limitations: [
        '固定fixtureでの診断プログラム比較。独立エージェント・別セッション・実pnpmの評価ではない。',
        '時間はローカル子プロセスの実測。LLM費用・CI費用は不明。',
      ],
      summary,
      runs,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
process.stdout.write(JSON.stringify({ output, summary }) + '\n');
process.exitCode = runs.some((run) => run.version === 'current' && !run.passed)
  ? 1
  : 0;
