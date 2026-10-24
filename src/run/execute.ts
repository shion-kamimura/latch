import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { toPosixPath } from '../verify/paths.js';
import { sanitizedEnvironment, permissionFlags } from './isolation.js';
import type {
  Evidence,
  EvidenceStatus,
  ExecuteSuiteOptions,
  SuiteResult,
  TestKind,
} from './types.js';

interface VitestAssertion {
  readonly title?: string;
  readonly fullName?: string;
  readonly status?: string;
  readonly failureMessages?: readonly string[];
}

interface VitestFileResult {
  readonly name?: string;
  readonly status?: string;
  readonly message?: string;
  readonly assertionResults?: readonly VitestAssertion[];
}

interface VitestJson {
  readonly success?: boolean;
  readonly numTotalTests?: number;
  readonly numFailedTests?: number;
  readonly numFailedTestSuites?: number;
  readonly testResults?: readonly VitestFileResult[];
}

const ISOLATION_SETUP = [
  "import { createRequire } from 'node:module';",
  '',
  'const require = createRequire(import.meta.url);',
  '',
  'function blocked(name) {',
  '  return (..._args) => {',
  '    throw new Error(`Latch isolation blocked ${name}`);',
  '  };',
  '}',
  '',
  'function patch(target, key, name) {',
  '  Object.defineProperty(target, key, {',
  '    value: blocked(name),',
  '    configurable: true,',
  '    writable: true,',
  '  });',
  '}',
  '',
  "const childProcess = require('node:child_process');",
  "for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {",
  '  patch(childProcess, name, `child_process.${name}`);',
  '}',
  '',
  "const workerThreads = require('node:worker_threads');",
  'patch(workerThreads, "Worker", "worker_threads.Worker");',
  '',
  "const net = require('node:net');",
  "const tls = require('node:tls');",
  "const http = require('node:http');",
  "const https = require('node:https');",
  "const dgram = require('node:dgram');",
  'patch(net.Socket.prototype, "connect", "net.Socket.prototype.connect");',
  'patch(tls, "connect", "tls.connect");',
  'patch(http, "request", "http.request");',
  'patch(https, "request", "https.request");',
  'patch(dgram, "createSocket", "dgram.createSocket");',
  '',
  'globalThis.fetch = blocked("fetch");',
  '',
].join('\n');

function truncate(
  text: string,
  maximum: number,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maximum) return { text, truncated: false };
  return {
    text: `${text.slice(0, maximum)}\n...[truncated]`,
    truncated: true,
  };
}

function displayCommand(
  workspace: ExecuteSuiteOptions['workspace'],
  include: readonly string[],
): string {
  const files = include.length > 0 ? include.join(' ') : '<all tests>';
  return [
    'node',
    '<permission flags>',
    '<latch vitest>',
    'run',
    '--root',
    '<isolated-root>',
    '--config',
    '<generated-config>',
    '--reporter=json',
    '--reporter=default',
    files,
  ].join(' ');
}

function classifyNoJson(
  kind: TestKind,
  log: string,
  timedOut: boolean,
): EvidenceStatus {
  if (timedOut) return 'timeout';
  if (
    /Startup Error|failed to start|ERR_ACCESS_DENIED|Cannot find native binding|permission denied|EACCES|setup-isolation/iu.test(
      log,
    )
  ) {
    return 'runner-startup-failed';
  }
  if (
    /SyntaxError|Transform failed|Failed to parse|Unexpected token|Expression expected|No test suite found|Failed to collect/iu.test(
      log,
    )
  ) {
    return kind === 'generated'
      ? 'invalid-generated-test'
      : 'runner-startup-failed';
  }
  if (
    /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/iu.test(log)
  ) {
    return kind === 'generated'
      ? 'invalid-generated-test'
      : 'environment-insufficient';
  }
  return kind === 'generated'
    ? 'invalid-generated-test'
    : 'runner-startup-failed';
}

function readReport(path: string): VitestJson | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as VitestJson;
  } catch {
    return null;
  }
}

function assertionStatus(value: string | undefined): EvidenceStatus {
  if (value === 'passed') return 'passed';
  if (value === 'failed') return 'assertion-failed';
  return 'skipped';
}

function evidenceFor(
  options: ExecuteSuiteOptions,
  file: string,
  testName: string,
  status: EvidenceStatus,
  command: string,
  exitCode: number | null,
  signal: string | null,
  durationMs: number,
  log: string,
  conditionIds: readonly string[],
  index: number,
): Evidence {
  const bounded = truncate(log, options.settings.limits.maxOutputBytes);
  return {
    id: `evidence-${options.kind}-${String(index + 1).padStart(3, '0')}`,
    kind: options.kind,
    conditionIds,
    testName,
    file,
    content: null,
    command,
    exitCode,
    signal,
    durationMs,
    status,
    log: bounded.text,
    logTruncated: bounded.truncated,
  };
}

export function executeSuite(options: ExecuteSuiteOptions): SuiteResult {
  const { workspace, settings, include, kind } = options;
  if (include.length === 0) {
    return { evidence: [], status: 'skipped', setupFailure: false };
  }

  const configDirectory = join(workspace.workDir, '.latch');
  const configPath = join(configDirectory, `vitest-${options.name}.config.mjs`);
  const setupPath = join(configDirectory, 'setup-isolation.mjs');
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(join(workspace.root, 'artifacts'), { recursive: true });
  const outputPath = join(workspace.root, 'artifacts', `${options.name}.json`);
  writeFileSync(setupPath, ISOLATION_SETUP);
  writeFileSync(
    configPath,
    `export default {\n  test: {\n    environment: 'node',\n    include: ${JSON.stringify(include)},\n    setupFiles: [${JSON.stringify(setupPath)}],\n    fileParallelism: false,\n    pool: 'threads',\n  },\n};\n`,
  );

  const args = [
    `--max-old-space-size=${settings.limits.maxMemoryMb}`,
    ...permissionFlags(workspace),
    workspace.runnerPath,
    'run',
    '--root',
    workspace.workDir,
    '--config',
    configPath,
    '--reporter=json',
    '--reporter=default',
    '--outputFile',
    outputPath,
    ...include,
  ];
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: workspace.workDir,
    env: sanitizedEnvironment(workspace.root),
    encoding: 'utf8',
    timeout: settings.limits.timeoutMs,
    maxBuffer: Math.max(settings.limits.maxOutputBytes * 2, 1024 * 1024),
    windowsHide: true,
  });
  const durationMs = Date.now() - started;
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const log = [result.stdout ?? '', result.stderr ?? '']
    .filter(Boolean)
    .join('\n');
  const command = displayCommand(workspace, include);
  const report = readReport(outputPath);

  if (timedOut) {
    const evidence = include.map((file, index) =>
      evidenceFor(
        options,
        file,
        `timeout ${file}`,
        'timeout',
        command,
        result.status,
        result.signal,
        durationMs,
        `時間上限（${settings.limits.timeoutMs}ms）を超えたため子プロセスを終了しました。\n${log}`,
        kind === 'generated'
          ? (options.conditionIdsByTest?.(file, file) ?? [])
          : [],
        index,
      ),
    );
    return { evidence, status: 'timeout', setupFailure: true };
  }

  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT'
  ) {
    const evidence = evidenceFor(
      options,
      include.join(','),
      'test runner startup',
      'runner-startup-failed',
      command,
      result.status,
      result.signal,
      durationMs,
      `${result.error.message}\n${log}`,
      [],
      0,
    );
    return {
      evidence: [evidence],
      status: 'runner-startup-failed',
      setupFailure: true,
    };
  }

  if (report === null) {
    const runnerMissing =
      log.includes(workspace.runnerPath) &&
      /Cannot find module|ERR_MODULE_NOT_FOUND/iu.test(log);
    const status = runnerMissing
      ? 'runner-startup-failed'
      : classifyNoJson(kind, log, timedOut);
    const evidence = include.map((file, index) =>
      evidenceFor(
        options,
        file,
        file,
        status,
        command,
        result.status,
        result.signal,
        durationMs,
        log,
        kind === 'generated'
          ? (options.conditionIdsByTest?.(file, file) ?? [])
          : [],
        index,
      ),
    );
    return { evidence, status, setupFailure: status !== 'assertion-failed' };
  }

  const testResults = report.testResults ?? [];
  const evidence: Evidence[] = [];
  let counter = 0;
  let sawFailure = false;
  let sawPass = false;
  let sawInvalid = false;

  for (const fileResult of testResults) {
    const absoluteFile = fileResult.name ?? '';
    const file = absoluteFile.startsWith(workspace.workDir)
      ? toPosixPath(relative(workspace.workDir, absoluteFile))
      : absoluteFile;
    const assertions = fileResult.assertionResults ?? [];
    if (assertions.length === 0) {
      const status: EvidenceStatus =
        fileResult.status === 'passed'
          ? 'invalid-generated-test'
          : classifyNoJson(kind, `${fileResult.message ?? ''}\n${log}`, false);
      if (status === 'invalid-generated-test') sawInvalid = true;
      evidence.push(
        evidenceFor(
          options,
          file,
          file,
          status,
          command,
          result.status,
          result.signal,
          durationMs,
          `${fileResult.message ?? ''}\n${log}`,
          kind === 'generated'
            ? (options.conditionIdsByTest?.(absoluteFile, file) ?? [])
            : [],
          counter,
        ),
      );
      counter += 1;
      continue;
    }
    for (const assertion of assertions) {
      const name = assertion.fullName ?? assertion.title ?? file;
      const status = assertionStatus(assertion.status);
      if (status === 'assertion-failed') sawFailure = true;
      if (status === 'passed') sawPass = true;
      const conditionIds =
        kind === 'generated'
          ? (options.conditionIdsByTest?.(absoluteFile, name) ?? [])
          : (options.conditionIdsByTest?.(file, name) ?? []);
      evidence.push(
        evidenceFor(
          options,
          file,
          name,
          status,
          command,
          result.status,
          result.signal,
          durationMs,
          `${(assertion.failureMessages ?? []).join('\n')}\n${log}`,
          conditionIds,
          counter,
        ),
      );
      counter += 1;
    }
  }

  if (evidence.length === 0) {
    const status: EvidenceStatus =
      result.status === 0
        ? 'invalid-generated-test'
        : classifyNoJson(kind, log, false);
    evidence.push(
      evidenceFor(
        options,
        include.join(','),
        include.join(','),
        status,
        command,
        result.status,
        result.signal,
        durationMs,
        log,
        [],
        0,
      ),
    );
    if (status === 'invalid-generated-test') sawInvalid = true;
  }

  let status: EvidenceStatus = 'passed';
  if (sawFailure) status = 'assertion-failed';
  else if (sawInvalid) status = 'invalid-generated-test';
  else if (!sawPass) status = 'skipped';

  return {
    evidence,
    status,
    setupFailure: status === 'invalid-generated-test',
  };
}
