import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import {
  assertCliHost,
  invokeOfficialCli,
  SUPPORTED_CLI_VERSION,
} from '../../src/plan/llm.js';
import { codexPolicyArguments } from '../../src/plan/codex-policy.js';
const command = process.env.LATCH_OFFICIAL_CLI;
test.skipIf(!command || process.platform !== 'linux')(
  'checks the real Codex policy and unsigned account without a model turn',
  async ({ skip }) => {
    const binary = resolve(command!);
    const root = mkdtempSync(join(tmpdir(), 'latch-codex-check-'));
    const home = join(root, 'home');
    const cwd = join(root, 'cwd');
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'AGENTS.md'), 'instruction-sentinel-must-not-load');
    const env = {
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C',
    };
    try {
      try {
        assertCliHost(env);
      } catch {
        skip();
        return;
      }
      const version = spawnSync(binary, ['--version'], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe(`codex-cli ${SUPPORTED_CLI_VERSION}`);
      const responses = await new Promise<
        Record<number, Record<string, unknown>>
      >((resolveResult, reject) => {
        const child = spawn(
          binary,
          [
            ...codexPolicyArguments(),
            'app-server',
            '--stdio',
            '--strict-config',
          ],
          { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        let buffer = '';
        let bytes = 0;
        const result: Record<number, Record<string, unknown>> = {};
        let failure = false;
        const kill = () => {
          if (child.pid)
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
        };
        const timer = setTimeout(() => {
          failure = true;
          kill();
        }, 15000);
        const send = (value: unknown) =>
          child.stdin.write(`${JSON.stringify(value)}\n`);
        child.stdin.on('error', () => {});
        child.stderr.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1000000) {
            failure = true;
            kill();
          }
        });
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1000000) {
            failure = true;
            kill();
            return;
          }
          buffer += chunk.toString();
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (!line.trim()) continue;
            try {
              const value = JSON.parse(line) as {
                id?: number;
                result?: Record<string, unknown>;
                error?: unknown;
              };
              if (value.id === undefined) continue;
              if (value.error || !value.result) {
                failure = true;
                kill();
                return;
              }
              result[value.id] = value.result;
              if (value.id === 1) {
                send({ method: 'initialized', params: {} });
                send({
                  id: 2,
                  method: 'account/read',
                  params: { refreshToken: false },
                });
              }
              if (value.id === 2)
                send({
                  id: 3,
                  method: 'config/read',
                  params: { includeLayers: false },
                });
              if (value.id === 3)
                send({
                  id: 4,
                  method: 'thread/start',
                  params: {
                    cwd,
                    ephemeral: true,
                    model: 'gpt-6.1-sol',
                    approvalPolicy: 'never',
                  },
                });
              if (value.id === 4) child.stdin.end();
            } catch {
              failure = true;
              kill();
            }
          }
        });
        child.on('error', () => {
          failure = true;
          kill();
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (failure || code !== 0)
            reject(
              Error('Official Codex inspection failed; raw output withheld.'),
            );
          else resolveResult(result);
        });
        send({
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'latch-policy-check', version: '0.0.0' },
          },
        });
      });
      expect(responses[2]?.account).toBeNull();
      const config = responses[3]?.config as {
        default_permissions: string;
        permissions: Record<
          string,
          { filesystem: Record<string, string>; network: { enabled: boolean } }
        >;
        features: Record<string, boolean>;
        web_search: string;
        project_doc_max_bytes: number;
      };
      expect(config.default_permissions).toBe('latch');
      expect(config.permissions.latch?.filesystem[':root']).toBe('deny');
      expect(config.permissions.latch?.network.enabled).toBe(false);
      for (const key of [
        'shell_tool',
        'view_image',
        'js_repl',
        'codex_hooks',
        'plugins',
        'apps',
        'collab',
      ])
        expect(config.features[key]).toBe(false);
      expect(config.features.skip_host_skill_discovery).toBe(true);
      expect(config.web_search).toBe('disabled');
      expect(config.project_doc_max_bytes).toBe(0);
      expect(responses[4]?.activePermissionProfile).toMatchObject({
        id: 'latch',
      });
      expect(responses[4]?.instructionSources).toEqual([]);
      expect(responses[4]?.modelProvider).toBe('openai');
      expect(responses[4]?.sandbox).toMatchObject({ networkAccess: false });
      // Also cross the product's real subprocess boundary. No turn is submitted
      // because account/read has already returned an unauthenticated account.
      const path = join(root, 'bin');
      mkdirSync(path);
      const { symlinkSync } = await import('node:fs');
      symlinkSync(binary, join(path, 'codex'));
      let hostSupported = true;
      try {
        assertCliHost(env);
      } catch {
        hostSupported = false;
      }
      await expect(
        invokeOfficialCli({
          system: 'fixed system',
          user: 'do not send',
          model: 'gpt-6.1-sol',
          env: { ...env, PATH: `${path}:${env.PATH}` },
          limits: {
            maxRequests: 1,
            timeoutMs: 15000,
            maxOutputBytes: 1000000,
            maxInputCharacters: 1000,
          },
        }),
      ).rejects.toThrow(hostSupported ? '未ログイン' : '管理者設定');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
