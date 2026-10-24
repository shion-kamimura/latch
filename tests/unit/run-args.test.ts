import { describe, expect, test } from 'vitest';
import { parseRunArgs } from '../../src/run/args.js';
import { VerificationInputError } from '../../src/verify/errors.js';

function expectInputError(callback: () => unknown): VerificationInputError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(VerificationInputError);
    return error as VerificationInputError;
  }
  throw new Error('expected a verification input error');
}

describe('run arguments', () => {
  test('parses a plan, profile, and JSON output', () => {
    expect(
      parseRunArgs(['--plan', 'plan.json', '--profile=profile.json', '--json']),
    ).toEqual({
      plan: 'plan.json',
      profile: 'profile.json',
      json: true,
    });
  });

  test('requires --plan', () => {
    const error = expectInputError(() => parseRunArgs(['--json']));
    expect(error.message).toContain('--plan');
  });

  test('rejects unknown options and duplicate flags', () => {
    expect(() => parseRunArgs(['--plan', 'a.json', '--base', 'main'])).toThrow(
      VerificationInputError,
    );
    expect(() =>
      parseRunArgs(['--plan', 'a.json', '--plan', 'b.json']),
    ).toThrow(VerificationInputError);
  });
});
