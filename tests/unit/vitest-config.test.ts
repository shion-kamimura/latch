import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadProjects() {
  vi.resetModules();
  const module = await import('../../vitest.config.js');
  const config = module.default as {
    test: { projects: { test: { name: string; root?: string } }[] };
  };
  return config.test.projects;
}

test('default projects stay limited to the repository test layers', async () => {
  const projects = await loadProjects();
  expect(projects.map((project) => project.test.name)).toEqual([
    'unit',
    'integration',
    'e2e',
  ]);
});

test('fixture project is only added when a root is provided', async () => {
  vi.stubEnv('LATCH_FIXTURE_ROOT', '/path/to/fixture');
  const projects = await loadProjects();
  const fixture = projects.find((project) => project.test.name === 'fixture');
  expect(fixture?.test.root).toBe('/path/to/fixture');
});
