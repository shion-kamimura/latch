import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['unit', 'integration', 'e2e'].map((name) => ({
      test: {
        name,
        environment: 'node',
        include: [`tests/${name}/**/*.test.ts`],
      },
    })),
  },
});
