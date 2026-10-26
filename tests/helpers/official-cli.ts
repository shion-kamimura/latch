import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { SUPPORTED_CLI_VERSION } from '../../src/plan/llm.js';

// A process fixture, never a real account or model. Records inference stdin,
// argv and selected environment fields to check the production process boundary.
export function createFakeCli(directory: string) {
  const config = join(directory, 'cli-response.json');
  const record = join(directory, 'cli-requests.jsonl');
  const executable = join(directory, 'claude');
  writeFileSync(record, '');
  writeFileSync(
    executable,
    `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'));
if (args.includes('--version')) { console.log(config.version ?? ${JSON.stringify(`${SUPPORTED_CLI_VERSION} (Claude Code)`)}); process.exit(0); }
if (args.includes('status')) { console.log(JSON.stringify(config.auth ?? { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', apiProvider: 'firstParty', configDirectory: process.env.HOME + '/.claude' })); process.exit(config.authExit ?? 0); }
let input = '';
for await (const data of process.stdin) input += data.toString();
appendFileSync(${JSON.stringify(record)}, JSON.stringify({args, input, cwd: process.cwd(), env: Object.fromEntries(['HOME', 'LATCH_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))}) + '\\n');
if (config.sleep) await new Promise(resolve => setTimeout(resolve, config.sleep));
if (config.stderr) process.stderr.write(config.stderr);
if (config.raw !== undefined) process.stdout.write(config.raw);
else console.log(JSON.stringify(config.envelope ?? {type: 'result', subtype: 'success', is_error: false, structured_output: config.response}));
process.exitCode = config.exit ?? 0;
`,
  );
  chmodSync(executable, 0o700);
  return {
    env: {
      HOME: directory,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
    },
    configure(value: Record<string, unknown>) {
      writeFileSync(config, JSON.stringify(value));
    },
    requests(): {
      args: string[];
      input: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
    }[] {
      return readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              args: string[];
              input: string;
              cwd: string;
              env: NodeJS.ProcessEnv;
            },
        );
    },
  };
}
