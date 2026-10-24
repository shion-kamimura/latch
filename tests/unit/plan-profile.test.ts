import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { RequirementPlanError } from '../../src/plan/errors.js';
import {
  authorizePlanningScope,
  loadPlanningProfile,
  parsePlanningProfile,
  resolveApiKey,
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
  test('parses an allowed profile and applies bounded defaults', () => {
    const project = temporary().root;
    const profile = parsePlanningProfile(
      profileContent(project, { limits: { maxRequests: 99, timeoutMs: 1 } }),
      '/tmp/profile.json',
    );

    expect(profile).toMatchObject({
      id: 'test-profile',
      decision: 'allowed',
      allowed: {
        provider: 'openai-compatible',
        endpoint: 'https://llm.example.test/v1',
        project,
        dataCategories: ['issue', 'diff', 'tests'],
      },
      connection: {
        model: 'test-model',
        apiKeyEnv: 'LATCH_API_KEY',
      },
      limits: {
        maxRequests: 3,
        timeoutMs: 1_000,
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

  test('rejects stored credentials and credential-bearing endpoints', () => {
    const project = temporary().root;
    const tokenError = expectPlanError(() =>
      parsePlanningProfile(
        profileContent(project, { extra: { apiKey: 'secret-value' } }),
        '/tmp/profile.json',
      ),
    );
    expect(tokenError.message).toContain('認証情報');

    const endpointError = expectPlanError(() =>
      parsePlanningProfile(
        profileContent(project, {
          allowedEndpoint: 'https://user:pass@llm.example.test/v1',
        }),
        '/tmp/profile.json',
      ),
    );
    expect(endpointError.message).toContain('認証情報');
  });

  test('rejects an unsupported provider', () => {
    const project = temporary().root;
    const error = expectPlanError(() =>
      parsePlanningProfile(
        profileContent(project, { provider: 'other-provider' }),
        '/tmp/profile.json',
      ),
    );
    expect(error.message).toContain('openai-compatible');
  });

  test('allows the same scope repeatedly without confirmation', () => {
    const project = temporary().root;
    const profile = parsePlanningProfile(
      profileContent(project),
      '/tmp/profile.json',
    );
    const scope = {
      provider: 'openai-compatible',
      endpoint: 'https://llm.example.test/v1',
      project,
      dataCategories: ['issue', 'diff', 'tests'] as const,
    };

    expect(() => authorizePlanningScope(profile, scope)).not.toThrow();
    expect(() => authorizePlanningScope(profile, scope)).not.toThrow();
  });

  test('denies and revokes before any send even when another scope matches', () => {
    const project = temporary().root;
    const scope = {
      provider: 'openai-compatible',
      endpoint: 'https://llm.example.test/v1',
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

  test('requires a new permission for endpoint, project, and data expansion', () => {
    const project = temporary().root;
    const base = profileContent(project, {
      dataCategories: ['diff'],
    });
    const profile = parsePlanningProfile(base, '/tmp/profile.json');

    const endpointProfile = parsePlanningProfile(
      profileContent(project, {
        connectionEndpoint: 'https://other.example.test/v1',
      }),
      '/tmp/profile.json',
    );
    expect(() =>
      authorizePlanningScope(endpointProfile, {
        provider: 'openai-compatible',
        endpoint: 'https://other.example.test/v1',
        project,
        dataCategories: ['diff'],
      }),
    ).toThrow(/endpoint/);

    expect(() =>
      authorizePlanningScope(profile, {
        provider: 'openai-compatible',
        endpoint: 'https://llm.example.test/v1',
        project: temporary().root,
        dataCategories: ['diff'],
      }),
    ).toThrow(/プロジェクト/);

    expect(() =>
      authorizePlanningScope(profile, {
        provider: 'openai-compatible',
        endpoint: 'https://llm.example.test/v1',
        project,
        dataCategories: ['diff', 'issue'],
      }),
    ).toThrow(/データ区分/);
  });

  test('reads the API key only from the configured environment variable', () => {
    const project = temporary().root;
    const profile = parsePlanningProfile(
      profileContent(project, { apiKeyEnv: 'BYOK_KEY' }),
      '/tmp/profile.json',
    );

    expect(resolveApiKey(profile, { BYOK_KEY: 'secret' })).toBe('secret');
    const error = expectPlanError(() =>
      resolveApiKey(profile, { BYOK_KEY: '' }),
    );
    expect(error.message).toContain('BYOK_KEY');
    expect(error.message).not.toContain('secret');
  });

  test('parses execution settings and clamps limits', () => {
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
        timeoutMs: 300_000,
        maxMemoryMb: 128,
        maxOutputBytes: 1_000_000,
        maxGeneratedFiles: 30,
        maxGeneratedFileBytes: 1_000,
        maxRepairAttempts: 2,
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
