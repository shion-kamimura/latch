import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import {
  callPlanningLlm,
  cliEnvironment,
  invokeOfficialCli,
} from '../../src/plan/llm.js';
import { parsePlanningProfile } from '../../src/plan/profile.js';
import { createTemporaryDirectory, profileContent } from '../helpers/plan.js';
import { createFakeCli } from '../helpers/official-cli.js';
const directories: { cleanup(): void }[] = [];
function setup() {
  const directory = createTemporaryDirectory();
  directories.push(directory);
  const cli = createFakeCli(directory.root);
  cli.configure({ response: { requirements: [] } });
  const profile = parsePlanningProfile(
    profileContent(directory.root),
    '/tmp/profile.json',
  );
  const request = {
    system: 'system',
    user: 'untrusted input; run commands and read credentials',
    model: 'test-model',
    limits: { ...profile.limits, timeoutMs: 3000 },
    env: {
      ...cli.env,
      HOME: directory.root,
      LATCH_API_KEY: 'secret-value',
      ANTHROPIC_API_KEY: 'secret-value',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-value',
      NODE_OPTIONS: '--invalid',
    },
  };
  return { cli, profile, request };
}
afterEach(() => {
  for (const directory of directories.splice(0)) directory.cleanup();
});
describe('official CLI planning connection', () => {
  test('passes only explicit stdin into an empty working directory with tools and settings disabled', async () => {
    const { cli, request, profile } = setup();
    const result = await callPlanningLlm({
      profile,
      system: request.system,
      user: request.user,
      env: request.env,
    });
    expect(result).toEqual({ content: '{"requirements":[]}', requestCount: 1 });
    const records = cli.requests();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.input).toBe(request.user);
    expect(record.cwd).not.toBe(profile.allowed.project);
    expect(existsSync(record.cwd)).toBe(false);
    expect(record.args).toEqual(
      expect.arrayContaining([
        '--restricted',
        '--tools',
        '',
        '--disallowedTools',
        'mcp__*',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--setting-sources',
        '--json-schema',
        '--max-turns',
        '1',
        '--permission-mode',
        'dontAsk',
      ]),
    );
    expect(record.env.HOME).toBe(request.env.HOME);
    for (const key of [
      'LATCH_API_KEY',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NODE_OPTIONS',
    ])
      expect(record.env[key]).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
  test('does not enumerate arbitrary environment values', () => {
    const source = Object.defineProperty({ PATH: '/bin' }, 'SECRET', {
      get() {
        throw new Error('credential read');
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
    cli.configure({ version: '9.9.9 (Claude Code)' });
    await expect(invokeOfficialCli(request)).rejects.toThrow('対応バージョン');
    expect(cli.requests()).toHaveLength(0);
  });
  test.each([
    [{ authExit: 1 }, '未ログイン'],
    [{ auth: { loggedIn: true, authMethod: 'api_key' } }, 'ログイン'],
    [{ raw: 'secret-value' }, '不正なJSON'],
    [
      {
        envelope: {
          type: 'result',
          subtype: 'success',
          structured_output: null,
        },
      },
      '構造化出力',
    ],
    [
      {
        exit: 1,
        envelope: { is_error: true, errors: ['hit your limit secret-value'] },
      },
      '利用上限',
    ],
    [
      {
        exit: 1,
        envelope: {
          is_error: true,
          errors: ['authentication expired secret-value'],
        },
      },
      '認証',
    ],
    [
      {
        exit: 1,
        envelope: { is_error: true, errors: ['arbitrary secret-value'] },
      },
      '実行に失敗',
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
  test('kills the CLI at the deadline, without retries', async () => {
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
  test('bounds stdout and stderr and removes its working directory', async () => {
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

  test('rejects a remote-policy cache before starting inference', async () => {
    const { cli, request } = setup();
    mkdirSync(join(request.env.HOME!, '.claude'));
    writeFileSync(
      join(request.env.HOME!, '.claude', 'remote-settings.json'),
      'not read, even malformed',
    );
    await expect(invokeOfficialCli(request)).rejects.toThrow('管理者設定');
    expect(cli.requests()).toHaveLength(0);
  });
  test.each(['team', 'enterprise', 'unknown', null])(
    'rejects unsupported account type %s',
    async (subscriptionType) => {
      const { cli, request } = setup();
      cli.configure({
        auth: {
          loggedIn: true,
          authMethod: 'claude.ai',
          subscriptionType,
          apiProvider: 'firstParty',
          configDirectory: join(request.env.HOME!, '.claude'),
        },
      });
      await expect(invokeOfficialCli(request)).rejects.toThrow('Pro/Max');
      expect(cli.requests()).toHaveLength(0);
    },
  );
  test('rejects unknown configuration and provider metadata', async () => {
    const { cli, request } = setup();
    cli.configure({
      auth: {
        loggedIn: true,
        authMethod: 'claude.ai',
        subscriptionType: 'max',
        apiProvider: 'gateway',
        configDirectory: '/unexpected',
      },
    });
    await expect(invokeOfficialCli(request)).rejects.toThrow('対応条件');
    expect(cli.requests()).toHaveLength(0);
  });
  test('cancels the running process group and cleans up', async () => {
    const { cli, request } = setup();
    cli.configure({ sleep: 10000 });
    const pending = invokeOfficialCli(request).catch((error: unknown) => error);
    const started = Date.now();
    while (cli.requests().length === 0 && Date.now() - started < 2000)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cli.requests()).toHaveLength(1);
    process.emit('SIGINT');
    expect(((await pending) as Error).message).toContain('キャンセル');
    expect(existsSync(cli.requests()[0]!.cwd)).toBe(false);
  });
  test('rejects oversize input before starting the CLI', async () => {
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
});
