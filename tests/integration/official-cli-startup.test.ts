import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertCliHost,
  officialCliArguments,
  SUPPORTED_CLI_VERSION,
} from '../../src/plan/llm.js';

// A separate, opt-in, no-model check of the unmodified official binary. Never
// reuse the caller's HOME, authentication files, tokens, or account settings.
const command = process.env.LATCH_OFFICIAL_CLI;
test.skipIf(!command || process.platform !== 'linux')(
  'checks the real official CLI startup without an account or model',
  () => {
    const binary = resolve(command!);
    const root = mkdtempSync(join(tmpdir(), 'latch-cli-check-'));
    try {
      const home = join(root, 'home');
      const cwd = join(root, 'cwd');
      const marker = join(root, 'hook-ran');
      for (const directory of [home, cwd]) {
        mkdirSync(join(directory, '.claude'), { recursive: true });
        const hook = {
          hooks: [
            {
              type: 'command',
              command: `touch '${marker.replaceAll("'", "'\\''")}'`,
            },
          ],
        };
        writeFileSync(
          join(directory, '.claude', 'settings.json'),
          JSON.stringify({
            hooks: { SessionStart: [hook], UserPromptSubmit: [hook] },
          }),
        );
      }
      const env = {
        HOME: home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C',
        TMPDIR: root,
      };
      assertCliHost(env);
      const run = (args: string[], input?: string) =>
        spawnSync(binary, args, {
          cwd,
          env,
          input,
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 1_000_000,
        });
      const version = run(['--version']);
      if (
        version.error ||
        version.status !== 0 ||
        version.stdout.trim() !== `${SUPPORTED_CLI_VERSION} (Claude Code)`
      )
        throw new Error('unsupported CLI version');
      const args = officialCliArguments({
        system: 'Return only the required JSON.',
        user: '',
        model: 'sonnet',
        env,
        limits: {
          timeoutMs: 15000,
          maxOutputBytes: 1000000,
          maxRequests: 1,
          maxInputCharacters: 1000,
        },
      });
      // The streaming envelope exposes the official tool registry before the
      // unauthenticated request fails. No account or paid model is available.
      args[args.indexOf('--output-format') + 1] = 'stream-json';
      args.push('--verbose');
      const result = run(args, 'Return {"requirements":[]}.');
      if (result.error)
        throw new Error('CLI did not finish within the check limits');
      const events = result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const init = events.find(
        (event) => event.type === 'system' && event.subtype === 'init',
      );
      const final = events.findLast((event) => event.type === 'result');
      if (
        !init ||
        JSON.stringify(init.tools) !== '["StructuredOutput"]' ||
        JSON.stringify(init?.mcp_servers) !== '[]' ||
        existsSync(marker) ||
        final?.is_error !== true ||
        !/log.?in|\/login|sign.?in/i.test(String(final.result))
      )
        throw new Error(
          'tool, hook, or unauthenticated-result contract mismatch',
        );
      console.log(
        JSON.stringify(
          {
            cli: 'claude-code',
            version: SUPPORTED_CLI_VERSION,
            tools: init.tools,
            mcpServers: init.mcp_servers,
            customHooksExecuted: false,
            authenticated: false,
            modelRequests: 0,
            note: 'No-model startup check; real-account plan/run evaluation remains separate.',
          },
          null,
          2,
        ),
      );
    } catch {
      // No raw CLI output: even this diagnostic follows the production logging rule.
      throw new Error(
        'Official CLI startup check failed. Verify the supported binary and its startup contract. Raw output is withheld.',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
