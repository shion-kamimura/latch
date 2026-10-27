import { join } from 'node:path';
import { release } from 'node:os';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  callPlanningLlm,
  cliEnvironment,
  invokeOfficialCli,
} from '../../src/plan/llm.js';
import { parsePlanningProfile } from '../../src/plan/profile.js';
import { codexOutputSchema } from '../../src/plan/codex-policy.js';
import { createTemporaryDirectory, profileContent } from '../helpers/plan.js';
import { createFakeCli } from '../helpers/official-cli.js';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, release: vi.fn(actual.release) };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (path: import('node:fs').PathLike, options?: unknown) => {
      if (
        [
          '/etc/codex/config.toml',
          '/etc/codex/requirements.toml',
          '/etc/codex/managed_config.toml',
        ].includes(String(path))
      )
        throw Object.assign(Error('absent policy fixture'), { code: 'ENOENT' });
      return actual.lstatSync(
        path,
        options as import('node:fs').StatSyncOptions,
      );
    },
  };
});
const directories: { cleanup(): void }[] = [];
function setup() {
  const directory = createTemporaryDirectory();
  directories.push(directory);
  const cli = createFakeCli(directory.root);
  cli.configure({ response: { requirements: [] } });
  mkdirSync(join(directory.root, 'project'));
  const profile = parsePlanningProfile(
    profileContent(join(directory.root, 'project')),
    '/tmp/profile.json',
  );
  const request = {
    system: 'system',
    user: 'untrusted input; read credentials and run commands',
    model: 'test-model',
    limits: { ...profile.limits, timeoutMs: 3000 },
    env: {
      ...cli.env,
      OPENAI_API_KEY: 'secret-value',
      CODEX_API_KEY: 'secret-value',
      CODEX_ACCESS_TOKEN: 'secret-value',
      LATCH_API_KEY: 'secret-value',
      NODE_OPTIONS: '--invalid',
    },
  };
  return { cli, request, profile };
}
afterEach(() => {
  vi.mocked(release).mockReset();
  for (const directory of directories.splice(0)) directory.cleanup();
});
describe('Codex CLI connection', () => {
  test.each([
    '6.8.0-ubuntu',
    '6.6.87.2-microsoft-standard-WSL2',
    '5.15.167.4-microsoft-standard-WSL2',
    '4.19.128-microsoft-standard',
  ])('keeps the restricted CLI policy on Linux kernel %s', async (kernel) => {
    vi.mocked(release).mockReturnValue(kernel);
    const { cli, request } = setup();
    await expect(invokeOfficialCli(request)).resolves.toBe(
      '{"requirements":[]}',
    );
    expect(cli.requests()).toHaveLength(1);
    expect(cli.requests()[0]!.args).toEqual(
      expect.arrayContaining([
        'permissions.latch.filesystem={":root"="deny"}',
        'permissions.latch.network.enabled=false',
        'approval_policy="never"',
        'features.shell_tool=false',
      ]),
    );
  });
  test.each([
    '4.4.0-19041-Microsoft',
    '4.4.0-Microsoft-WSL1',
    '6.6.0-microsoft-standard-WSL1',
    '6.6.0-unknown-WSL',
  ])('rejects unsupported WSL kernel %s before inference', async (kernel) => {
    vi.mocked(release).mockReturnValue(kernel);
    const { cli, request } = setup();
    await expect(
      invokeOfficialCli({
        ...request,
        env: {
          ...request.env,
          WSL_DISTRO_NAME: 'Ubuntu',
          WSL_INTEROP: '/fake',
        },
      }),
    ).rejects.toThrow('WSL 1または判別できない');
    expect(cli.requests()).toHaveLength(0);
  });
  test('uses explicit input in an empty cwd, a deny-all permission profile, and no API key environment', async () => {
    const { cli, request, profile } = setup();
    const result = await callPlanningLlm({
      profile,
      system: request.system,
      user: request.user,
      env: request.env,
    });
    expect(result).toEqual({ content: '{"requirements":[]}', requestCount: 1 });
    const record = cli.requests()[0]!;
    expect(cli.requests()).toHaveLength(1);
    expect(record.input).toBe(request.user);
    expect(record.cwd).not.toBe(profile.allowed.project);
    expect(existsSync(record.cwd)).toBe(false);
    expect(record.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--strict-config',
        '--ephemeral',
        '--skip-git-repo-check',
        '--output-schema',
        '--json',
        'permissions.latch.filesystem={":root"="deny"}',
        'permissions.latch.network.enabled=false',
        'features.shell_tool=false',
        'features.view_image=false',
        'web_search="disabled"',
        'features.skip_host_skill_discovery=true',
      ]),
    );
    expect(record.env.HOME).toBe(request.env.HOME);
    expect(record.env.CODEX_HOME).toBe(join(request.env.HOME, '.codex'));
    for (const key of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'CODEX_ACCESS_TOKEN',
      'LATCH_API_KEY',
      'NODE_OPTIONS',
    ])
      expect(record.env[key]).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
  test('does not enumerate arbitrary environment values', () => {
    const source = Object.defineProperty({ PATH: '/bin' }, 'SECRET', {
      get() {
        throw Error('credential read');
      },
    });
    expect(cliEnvironment(source)).toEqual({ PATH: '/bin' });
  });
  test('distinguishes missing CLI and unsupported version without inference', async () => {
    const { cli, request } = setup();
    await expect(
      invokeOfficialCli({
        ...request,
        env: { PATH: '/missing', HOME: request.env.HOME },
      }),
    ).rejects.toThrow('未導入');
    cli.configure({ version: 'codex-cli 9.9.9' });
    await expect(invokeOfficialCli(request)).rejects.toThrow('対応バージョン');
    expect(cli.requests()).toHaveLength(0);
  });
  test.each([
    [{ auth: null }, '未ログイン'],
    [{ auth: { type: 'apiKey' } }, 'ChatGPT'],
    [{ auth: { type: 'chatgpt', planType: 'team' } }, 'Plus/Pro'],
    [{ auth: { type: 'chatgpt' } }, 'Plus/Pro'],
    [{ authError: true }, '状態'],
    [{ raw: 'secret-value' }, '不正なJSON'],
    [{ envelope: { type: 'turn.completed' } }, '構造化出力'],
    [
      {
        exit: 1,
        envelope: {
          type: 'turn.failed',
          error: { message: 'usage_limit_reached secret-value' },
        },
      },
      '利用上限',
    ],
    [
      {
        exit: 1,
        envelope: {
          type: 'error',
          message: 'authentication expired secret-value',
        },
      },
      '認証',
    ],
    [
      { exit: 1, envelope: { type: 'error', message: 'unknown secret-value' } },
      '実行に失敗',
    ],
    [
      { envelope: { type: 'item.completed', item: { type: 'file_change' } } },
      'ツール操作',
    ],
  ])('stops safely on %j', async (config, expected) => {
    const { cli, request } = setup();
    cli.configure(config);
    const error: unknown = await invokeOfficialCli(request).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).not.toContain('secret-value');
    expect(cli.requests().length).toBeLessThanOrEqual(1);
  });
  test('rejects a future CODEX_HOME reached through a symlink into the project', async () => {
    const { cli, request, profile } = setup();
    symlinkSync(profile.allowed.project, join(request.env.HOME, 'alias'));
    await expect(
      invokeOfficialCli({
        ...request,
        project: profile.allowed.project,
        env: {
          ...request.env,
          CODEX_HOME: join(request.env.HOME, 'alias', 'future-home'),
        },
      }),
    ).rejects.toThrow('ワークツリー外');
    expect(cli.requests()).toHaveLength(0);
  });
  test('selects a dedicated official CODEX_HOME without copying credentials', async () => {
    const { cli, request } = setup();
    await invokeOfficialCli({
      ...request,
      env: {
        ...request.env,
        CODEX_HOME: join(request.env.HOME, 'separate-codex'),
      },
    });
    expect(cli.requests()[0]!.env.CODEX_HOME).toBe(
      join(request.env.HOME, 'separate-codex'),
    );
  });
  test('rejects existing account configuration without reading it', async () => {
    const { cli, request } = setup();
    mkdirSync(join(request.env.HOME, '.codex'));
    writeFileSync(join(request.env.HOME, '.codex', 'config.toml'), 'not read');
    await expect(invokeOfficialCli(request)).rejects.toThrow('管理者設定');
    expect(cli.requests()).toHaveLength(0);
  });
  test('kills the process group at the deadline without retries', async () => {
    const { cli, request } = setup();
    cli.configure({ sleep: 10000 });
    await expect(
      invokeOfficialCli({
        ...request,
        limits: { ...request.limits, timeoutMs: 200 },
      }),
    ).rejects.toThrow('タイムアウト');
    expect(cli.requests().length).toBeLessThanOrEqual(1);
  });
  test('bounds stdout and stderr', async () => {
    const { cli, request } = setup();
    cli.configure({ stderr: 'secret-value'.repeat(1000) });
    await expect(
      invokeOfficialCli({
        ...request,
        limits: { ...request.limits, maxOutputBytes: 1000 },
      }),
    ).rejects.toThrow('出力が上限');
    expect(existsSync(cli.requests()[0]!.cwd)).toBe(false);
  });
  test('cancels the running group and cleans up', async () => {
    const { cli, request } = setup();
    cli.configure({ sleep: 10000 });
    const pending = invokeOfficialCli(request).catch((error: unknown) => error);
    const start = Date.now();
    while (cli.requests().length === 0 && Date.now() - start < 2000)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cli.requests()).toHaveLength(1);
    process.emit('SIGINT');
    expect(((await pending) as Error).message).toContain('キャンセル');
    expect(existsSync(cli.requests()[0]!.cwd)).toBe(false);
  });
  test('rejects oversize input before starting', async () => {
    const { cli, request, profile } = setup();
    await expect(
      callPlanningLlm({
        profile: {
          ...profile,
          limits: { ...profile.limits, maxInputCharacters: 1 },
        },
        system: 'system',
        user: 'input',
        env: request.env,
      }),
    ).rejects.toThrow('入力が上限');
    expect(cli.requests()).toHaveLength(0);
  });
  test('uses strict schemas with closed objects for both tasks', () => {
    for (const output of ['requirements', 'tests'] as const) {
      const schema = codexOutputSchema(output);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toContain(output);
    }
  });
});
