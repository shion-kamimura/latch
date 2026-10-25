import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// Read-only development diagnosis. Do not install, run target code, or print
// subprocess errors: those can contain registry credentials or environment data.
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('package.json', root), 'utf8'),
) as { packageManager: string; devDependencies: Record<string, string> };
let nodeVersion: string | undefined;
try {
  const value = readFileSync(new URL('.node-version', root), 'utf8').trim();
  if (/^\d+(?:\.\d+){0,2}$/.test(value)) nodeVersion = value;
} catch {
  // Missing, unreadable, or non-file configuration is an environment problem.
}
const nodeMajor = nodeVersion?.split('.')[0];
const pnpmVersion = manifest.packageManager.replace(/^pnpm@/, '');
const require = createRequire(new URL('package.json', root));
const checks: { name: string; ok: boolean; detail: string }[] = [];

checks.push({
  name: 'Node.js',
  ok: process.versions.node.split('.')[0] === nodeMajor,
  detail: nodeVersion
    ? `現在 ${process.versions.node} / 必要 ${nodeMajor}.x（推奨 ${nodeVersion}）。異なる場合はNode.jsを切り替えてください。`
    : '.node-versionを読めないか形式が不正です。対象branchの設定ファイルを確認してください。',
});

try {
  const actual = execFileSync('pnpm', ['--version'], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      COREPACK_ENABLE_NETWORK: '0',
      npm_config_manage_package_manager_versions: 'false',
    },
  }).trim();
  checks.push({
    name: 'pnpm',
    ok: actual === pnpmVersion,
    detail: `必要 pnpm@${pnpmVersion}。PATH上のpnpmが指定版か確認してください。`,
  });
} catch {
  checks.push({
    name: 'pnpm',
    ok: false,
    detail: `起動できません。pnpm@${pnpmVersion}とPATHを確認してください（10秒で打ち切り）。`,
  });
}

let hasLockfile = false;
try {
  hasLockfile = statSync(new URL('pnpm-lock.yaml', root)).isFile();
} catch {
  // An absent or inaccessible lockfile must not become a successful diagnosis.
}
checks.push({
  name: 'lockfile',
  ok: hasLockfile,
  detail:
    '通常ファイルのpnpm-lock.yamlが必要です。対象branchとcheckoutを確認してください。',
});

const missing = Object.keys(manifest.devDependencies).filter((name) => {
  try {
    // Type-only packages have no runtime entry. Some runtime packages hide
    // package.json through exports, so accept either resolvable entry.
    try {
      require.resolve(`${name}/package.json`);
    } catch {
      require.resolve(name);
    }
    return false;
  } catch {
    return true;
  }
});
checks.push({
  name: '開発依存',
  ok: missing.length === 0,
  detail:
    missing.length === 0
      ? 'manifestの開発依存を解決できました。完全な整合性はfrozen installで確認してください。'
      : `不足: ${missing.join(', ')}。対象headで pnpm install --frozen-lockfile を実行してください。`,
});

for (const check of checks) {
  process.stdout.write(
    `${check.ok ? 'OK' : '不足'} ${check.name}: ${check.detail}\n`,
  );
}
const ready = checks.every((check) => check.ok);
process.stdout.write(
  ready
    ? '準備項目を確認しました。テスト・CI・隔離の安全性は未判定です。\n'
    : '環境不足があります。未実行のテストを成功として扱わないでください。\n',
);
process.exitCode = ready ? 0 : 1;
