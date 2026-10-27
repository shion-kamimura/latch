import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { RequirementPlanError } from '../../src/plan/errors.js';
import {
  authorizePlanningScope,
  loadPlanningProfile,
  parsePlanningProfile,
} from '../../src/plan/profile.js';
import {
  createProfileDirectory,
  createTemporaryDirectory,
  profileContent,
} from '../helpers/plan.js';

const directories: { cleanup(): void }[] = [];

function temporary() {
  const directory = createTemporaryDirectory();
  directories.push(directory);
  return directory;
}

function profileDirectory() {
  const directory = createProfileDirectory();
  directories.push(directory);
  return directory;
}

function expectPlanError(callback: () => unknown): RequirementPlanError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(RequirementPlanError);
    return error as RequirementPlanError;
  }
  throw new Error('expected a requirement plan error');
}

afterEach(() => {
  for (const directory of directories.splice(0)) directory.cleanup();
});

describe('planning permission profile', () => {
  test.each([undefined, null])(
    'does not impose optional resource ceilings for %s',
    (value) => {
      const profile = parsePlanningProfile(
        profileContent(
          temporary().root,
          value === undefined
            ? {}
            : {
                limits: {
                  timeoutMs: value ?? null,
                  maxRequests: value ?? null,
                },
                extra: {
                  execution: { limits: { maxOutputBytes: value ?? null } },
                },
              },
        ),
        '/tmp/profile.json',
      );
      expect(Object.values(profile.limits)).toEqual([null, null, null, null]);
      expect(profile.execution?.limits).toEqual({
        timeoutMs: null,
        maxMemoryMb: null,
        maxOutputBytes: null,
        maxGeneratedFiles: null,
        maxGeneratedFileBytes: null,
        maxRepairAttempts: 1,
      });
    },
  );
  test.each([-1, 0, 1.5, '30000', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid resource limits instead of replacing %s',
    (timeoutMs) => {
      expect(() =>
        parsePlanningProfile(
          profileContent(temporary().root, {
            extra: { limits: { timeoutMs } },
          }),
          '/tmp/profile.json',
        ),
      ).toThrow('正の整数または null');
    },
  );
  test('uses caller-selected planning limits without clamping', () => {
    const project = temporary().root;
    const profile = parsePlanningProfile(
      profileContent(project, { limits: { maxRequests: 99, timeoutMs: 1 } }),
      '/tmp/profile.json',
    );

    expect(profile).toMatchObject({
      id: 'test-profile',
      decision: 'allowed',
      allowed: {
        provider: 'codex-cli',
        project,
        dataCategories: ['issue', 'diff', 'tests'],
      },
      connection: {
        model: 'test-model',
      },
      limits: {
        maxRequests: 99,
        timeoutMs: 1,
      },
    });
  });

  test('requires a profile outside the worktree', () => {
    const directory = temporary();
    const repository = join(directory.root, 'repository');
    mkdirSync(repository);
    writeFileSync(join(repository, 'profile.json'), profileContent(repository));

    const error = expectPlanError(() =>
      loadPlanningProfile('profile.json', repository, repository),
    );
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('ワークツリー内');
  });

  test('loads a relative profile path from the provided cwd', () => {
    const repository = temporary();
    const profiles = profileDirectory();
    profiles.write('profile.json', profileContent(repository.root));

    const profile = loadPlanningProfile(
      'profile.json',
      repository.root,
      profiles.root,
    );

    expect(profile.path).toBe(join(profiles.root, 'profile.json'));
  });

  test('rejects stored credentials', () => {
    const project = temporary().root;
    const tokenError = expectPlanError(() =>
      parsePlanningProfile(
        profileContent(project, { extra: { apiKey: 'secret-value' } }),
        '/tmp/profile.json',
      ),
    );
    expect(tokenError.message).toContain('認証情報');
  });

  test('rejects an unsupported provider', () => {
    const project = temporary().root;
    const error = expectPlanError(() =>
      parsePlanningProfile(
        profileContent(project, { provider: 'other-provider' }),
        '/tmp/profile.json',
      ),
    );
    expect(error.message).toContain('codex-cli');
  });

  test('allows the same scope repeatedly without confirmation', () => {
    const project = temporary().root;
    const profile = parsePlanningProfile(
      profileContent(project),
      '/tmp/profile.json',
    );
    const scope = {
      provider: 'codex-cli',
      project,
      dataCategories: ['issue', 'diff', 'tests'] as const,
    };

    expect(() => authorizePlanningScope(profile, scope)).not.toThrow();
    expect(() => authorizePlanningScope(profile, scope)).not.toThrow();
  });

  test('denies and revokes before any send even when another scope matches', () => {
    const project = temporary().root;
    const scope = {
      provider: 'codex-cli',
      project,
      dataCategories: ['issue', 'diff', 'tests'] as const,
    };

    for (const decision of ['denied', 'revoked'] as const) {
      const profile = parsePlanningProfile(
        profileContent(project, { decision }),
        '/tmp/profile.json',
      );
      const error = expectPlanError(() =>
        authorizePlanningScope(profile, scope),
      );
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain(
        decision === 'denied' ? '拒否' : '取り消し',
      );
    }
  });

  test('requires a new permission for project and data expansion', () => {
    const project = temporary().root;
    const base = profileContent(project, {
      dataCategories: ['diff'],
    });
    const profile = parsePlanningProfile(base, '/tmp/profile.json');

    expect(() =>
      authorizePlanningScope(profile, {
        provider: 'codex-cli',
        project: temporary().root,
        dataCategories: ['diff'],
      }),
    ).toThrow(/プロジェクト/);

    expect(() =>
      authorizePlanningScope(profile, {
        provider: 'codex-cli',
        project,
        dataCategories: ['diff', 'issue'],
      }),
    ).toThrow(/データ区分/);
  });

  test('rejects legacy API profiles with migration guidance and no credential lookup', () => {
    const project = temporary().root;
    for (const legacy of [
      { ...JSON.parse(profileContent(project)), version: 1 },
      {
        ...JSON.parse(profileContent(project)),
        limits: { maxOutputTokens: 4096 },
      },
      {
        ...JSON.parse(profileContent(project)),
        connection: {
          provider: 'codex-cli',
          model: 'test',
          endpoint: 'https://example.test',
        },
      },
      {
        ...JSON.parse(profileContent(project)),
        connection: {
          provider: 'codex-cli',
          model: 'test',
          apiKeyEnv: 'SECRET',
        },
      },
    ]) {
      const error = expectPlanError(() =>
        parsePlanningProfile(JSON.stringify(legacy), '/tmp/profile.json'),
      );
      expect(error.message).toContain('旧API');
      expect(error.guidance).toContain('version: 2');
    }
  });

  test('uses caller-selected execution limits without clamping', () => {
    const project = temporary().root;
    const profile = parsePlanningProfile(
      profileContent(project, {
        extra: {
          execution: {
            dependencies: {
              mode: 'registry',
              registry: 'https://registry.example.test/',
            },
            network: { allowedDestinations: ['https://api.example.test'] },
            limits: {
              timeoutMs: 999_999,
              maxMemoryMb: 1,
              maxOutputBytes: 9_999_999,
              maxGeneratedFiles: 100,
              maxGeneratedFileBytes: 1,
              maxRepairAttempts: 9,
            },
          },
        },
      }),
      '/tmp/profile.json',
    );

    expect(profile.execution).toEqual({
      dependencies: {
        mode: 'registry',
        registry: 'https://registry.example.test',
      },
      network: { allowedDestinations: ['https://api.example.test'] },
      limits: {
        timeoutMs: 999_999,
        maxMemoryMb: 1,
        maxOutputBytes: 9_999_999,
        maxGeneratedFiles: 100,
        maxGeneratedFileBytes: 1,
        maxRepairAttempts: 9,
      },
    });
  });

  test('rejects a registry mode without a registry and insecure registries', () => {
    const project = temporary().root;
    const missing = expectPlanError(() =>
      parsePlanningProfile(
        profileContent(project, {
          extra: {
            execution: { dependencies: { mode: 'registry' } },
          },
        }),
        '/tmp/profile.json',
      ),
    );
    expect(missing.message).toContain('registry');

    const insecure = expectPlanError(() =>
      parsePlanningProfile(
        profileContent(project, {
          extra: {
            execution: {
              dependencies: {
                mode: 'registry',
                registry: 'http://registry.example.test',
              },
            },
          },
        }),
        '/tmp/profile.json',
      ),
    );
    expect(insecure.message).toContain('HTTPS');
  });
});
