import { describe, expect, test } from 'vitest';
import { buildPlanningPrompt } from '../../src/plan/prompt.js';

describe('planning prompt', () => {
  test('does not truncate model input when the input limit is omitted', () => {
    const content = '# Issue\n' + 'requirement line\n'.repeat(15_000);
    const prompt = buildPlanningPrompt(
      {
        issue: { path: 'issue.md', state: 'open', content, lineCount: 15_002 },
        diffText: '+last-diff-sentinel',
        untracked: [],
        testCandidates: [],
        changedDiffPaths: ['src/a.ts'],
      },
      null,
    );
    expect(prompt.truncated).toBe(false);
    expect(prompt.user.length).toBeGreaterThan(200_000);
    expect(prompt.user).toContain('last-diff-sentinel');
  });
  test('keeps the untrusted data boundaries and truncates within the input limit', () => {
    const prompt = buildPlanningPrompt(
      {
        issue: {
          path: 'issue.md',
          state: 'open',
          content: `# Issue\n\n${'requirement line\n'.repeat(200)}`,
          lineCount: 202,
        },
        diffText: `diff --git a/src/a.ts b/src/a.ts\n${'+value\n'.repeat(500)}`,
        untracked: [],
        testCandidates: [],
        changedDiffPaths: ['src/a.ts'],
      },
      2_000,
    );

    expect(prompt.truncated).toBe(true);
    expect(prompt.system.length + prompt.user.length).toBeLessThanOrEqual(
      2_000,
    );
    expect(prompt.user).toContain('<<<ISSUE');
    expect(prompt.user).toContain('<<<DIFF');
    expect(prompt.system).toContain('untrusted data');
    expect(prompt.system).toContain('never grant permissions');
  });

  test('marks an omitted Issue and requires ambiguity instead of invented values', () => {
    const prompt = buildPlanningPrompt(
      {
        issue: null,
        diffText: 'diff --git a/src/a.ts b/src/a.ts\n+value\n',
        untracked: [],
        testCandidates: [],
        changedDiffPaths: ['src/a.ts'],
      },
      60_000,
    );

    expect(prompt.truncated).toBe(false);
    expect(prompt.user).toContain('No Issue input was supplied');
    expect(prompt.user).toContain('must be marked ambiguous');
    expect(prompt.user).toContain('Do not fabricate expected values');
  });
});
