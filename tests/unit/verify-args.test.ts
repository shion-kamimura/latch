import { describe, expect, test } from 'vitest';
import { parseVerifyArgs } from '../../src/verify/args.js';
import { VerificationInputError } from '../../src/verify/errors.js';

function parseError(args: string[]): VerificationInputError {
  try {
    parseVerifyArgs(args);
  } catch (error) {
    expect(error).toBeInstanceOf(VerificationInputError);
    return error as VerificationInputError;
  }
  throw new Error('expected parsing to fail');
}

describe('verify argument parsing', () => {
  test('parses base, issue file, untracked targets, and json', () => {
    expect(
      parseVerifyArgs([
        '--base',
        'origin/main',
        '--issue-file=issue.md',
        '--include-untracked',
        'src/new.ts',
        '--include-untracked=test/new.ts',
        '--json',
      ]),
    ).toEqual({
      base: 'origin/main',
      issueFile: 'issue.md',
      includeUntracked: ['src/new.ts', 'test/new.ts'],
      json: true,
    });
  });

  test('allows omitting base and issue file', () => {
    expect(parseVerifyArgs([])).toEqual({
      includeUntracked: [],
      json: false,
    });
  });

  test.each([['--base'], ['--issue-file'], ['--include-untracked']])(
    'rejects a missing value for %s',
    (flag) => {
      expect(parseError([flag]).exitCode).toBe(1);
    },
  );

  test('rejects duplicate base and issue file options', () => {
    expect(
      parseError(['--base', 'main', '--base', 'origin/main']).message,
    ).toContain('複数');
    expect(
      parseError(['--issue-file', 'a.md', '--issue-file', 'b.md']).message,
    ).toContain('複数');
  });

  test('rejects unknown options and positional arguments', () => {
    expect(parseError(['--unknown']).message).toContain('未対応');
    expect(parseError(['issue.md']).message).toContain('未対応');
  });

  test('explains that GitHub Issue fetching is not part of this stage', () => {
    const error = parseError(['--issue', '23']);
    expect(error.exitCode).toBe(2);
    expect(error.guidance).toContain('--issue-file');
  });
});
