import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ProfileOverrides {
  decision?: 'allowed' | 'denied' | 'revoked';
  provider?: string;
  allowedEndpoint?: string;
  connectionEndpoint?: string;
  project?: string;
  dataCategories?: string[];
  model?: string;
  apiKeyEnv?: string;
  limits?: Record<string, number>;
  extra?: Record<string, unknown>;
}

export function profileContent(
  project: string,
  overrides: ProfileOverrides = {},
): string {
  return JSON.stringify(
    {
      version: 1,
      id: 'test-profile',
      decision: overrides.decision ?? 'allowed',
      allowed: {
        provider: overrides.provider ?? 'openai-compatible',
        endpoint: overrides.allowedEndpoint ?? 'https://llm.example.test/v1',
        project,
        dataCategories: overrides.dataCategories ?? ['issue', 'diff', 'tests'],
      },
      connection: {
        provider: overrides.provider ?? 'openai-compatible',
        endpoint: overrides.connectionEndpoint ?? 'https://llm.example.test/v1',
        model: overrides.model ?? 'test-model',
        apiKeyEnv: overrides.apiKeyEnv ?? 'LATCH_API_KEY',
      },
      ...(overrides.limits ? { limits: overrides.limits } : {}),
      ...overrides.extra,
    },
    null,
    2,
  );
}

export function createProfileDirectory(): {
  readonly root: string;
  write(name: string, content: string): string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'latch-plan-profile-'));
  return {
    root,
    write(name, content) {
      const path = join(root, name);
      writeFileSync(path, content);
      return path;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function createTemporaryDirectory(): {
  readonly root: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'latch-plan-test-'));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
