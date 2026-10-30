import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const ci = read('.github/workflows/ci.yml');
const opencode = read('.github/workflows/opencode.yml');
const workflows = [
  ['.github/workflows/ci.yml', ci],
  ['.github/workflows/opencode.yml', opencode],
] as const;

const workflowsDirectory = new URL('.github/workflows/', root);

function runsOnValues(workflow: string): string[] {
  return [...workflow.matchAll(/^\s+runs-on:\s+(\S+)$/gm)].map(
    ([, value]) => value!,
  );
}

function usesValues(workflow: string): string[] {
  return [...workflow.matchAll(/^\s+(?:- )?uses:\s+(\S+)$/gm)].map(
    ([, value]) => value!,
  );
}

describe('GitHub Actions runtime and runner pinning', () => {
  test.each(workflows)('%s pins every job to Ubuntu 24.04', (_, workflow) => {
    const runners = runsOnValues(workflow);
    expect(runners.length).toBeGreaterThan(0);
    expect(runners).toEqual(runners.map(() => 'ubuntu-24.04'));
    expect(workflow).not.toContain('ubuntu-latest');
  });

  test.each(workflows)(
    '%s uses Node.js 24 versions of first-party actions',
    (_, workflow) => {
      const actions = usesValues(workflow);
      expect(actions).toContain('actions/checkout@v5');
      expect(actions).toContain('actions/setup-node@v5');
      expect(actions).toContain('pnpm/action-setup@v6');
      expect(actions).not.toContain('actions/checkout@v4');
      expect(actions).not.toContain('actions/setup-node@v4');
      expect(actions).not.toContain('pnpm/action-setup@v4');
    },
  );

  test('OpenCode uses github-script v8 for both privileged and unprivileged steps', () => {
    const actions = usesValues(opencode);
    expect(actions).toContain('actions/github-script@v8');
    expect(actions).not.toContain('actions/github-script@v7');
    expect(
      actions.filter((action) => action === 'actions/github-script@v8'),
    ).toHaveLength(2);
  });

  test('the project still runs on Node.js 26', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      engines: { node: string };
      scripts: { test: string };
    };
    expect(read('.node-version').trim()).toMatch(/^26\./);
    expect(packageJson.engines.node).toBe('>=26 <27');
    expect(ci).toContain("node-version: '26'");
    expect(opencode).toContain("node-version: '26'");
  });
});

describe('CI order and retired automation', () => {
  test('CI runs independent checks without cancelling siblings on failure', () => {
    expect(ci).toContain('fail-fast: false');
    expect(ci).not.toMatch(/^\s+needs:/m);
    const expected = [
      ['Lint', 'pnpm lint'],
      ['Typecheck', 'pnpm typecheck'],
      ['Format', 'pnpm format:check'],
      ['Unit tests', 'pnpm test:unit'],
      ['Integration tests', 'pnpm test:integration'],
      ['Build', 'pnpm build'],
      ['CLI E2E', 'pnpm test:e2e'],
    ];
    for (const [name, command] of expected) {
      expect(ci).toContain(`- name: ${name}\n            command: ${command}`);
    }
    expect(ci).toContain('name: ${{ matrix.name }}');
    expect(ci).toContain('run: ${{ matrix.command }}');
    expect(ci).not.toContain('run: pnpm test\n');
  });

  test('E2E builds the CLI first and local test coverage is preserved', () => {
    const { scripts } = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['test:unit']).toBe('vitest run --project unit');
    expect(scripts['test:integration']).toBe(
      'vitest run --project integration',
    );
    expect(scripts['test:e2e']).toBe('vitest run --project e2e');
    expect(scripts.test).toBe(
      'vitest run --project unit --project integration && pnpm build && vitest run --project e2e',
    );
    expect(ci).toContain(
      "if: matrix.name == 'CLI E2E'\n        run: pnpm build",
    );
    expect(ci.indexOf('run: pnpm build')).toBeLessThan(
      ci.indexOf('run: ${{ matrix.command }}'),
    );
  });

  test('retired workflows and the Python automation base are not restored', () => {
    expect(
      existsSync(new URL('automation-checks.yml', workflowsDirectory)),
    ).toBe(false);
    expect(existsSync(new URL('issue-draft-pr.yml', workflowsDirectory))).toBe(
      false,
    );
    expect(existsSync(new URL('.github/automation', root))).toBe(false);
  });

  test('OpenCode authorization, authentication, and trigger boundaries remain', () => {
    expect(opencode).toMatch(/^on:\n {2}issue_comment:/m);
    expect(opencode).toMatch(/^ {2}pull_request_review_comment:/m);
    expect(opencode).toMatch(/if: vars\.OPENCODE_ENABLED == 'true'/);
    expect(opencode).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(opencode).toMatch(/^ {6}id-token: write$/m);
    expect(opencode).toContain("use_github_token: 'false'");
    expect(opencode).toContain('persist-credentials: false');
    expect(opencode).toContain(
      'uses: anomalyco/opencode/github@148842ef7cb1bc34192b3fff57d0f9721ab9c801',
    );
  });
});
