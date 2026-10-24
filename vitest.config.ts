import { defineConfig } from 'vitest/config';

const baseProjects = ['unit', 'integration', 'e2e'].map((name) => ({
  test: {
    name,
    environment: 'node',
    include: [`tests/${name}/**/*.test.ts`],
  },
}));

const fixtureRoot = process.env.LATCH_FIXTURE_ROOT;

const projects = fixtureRoot
  ? [
      ...baseProjects,
      {
        test: {
          name: 'fixture',
          environment: 'node',
          root: fixtureRoot,
          include: ['test/**/*.test.{ts,mjs}'],
        },
      },
    ]
  : baseProjects;

export default defineConfig({
  test: {
    projects,
  },
});
