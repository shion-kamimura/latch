import { VerificationInputError } from '../verify/errors.js';
import type { RunOptions } from './types.js';

function readValue(
  args: readonly string[],
  index: number,
  flag: string,
  inline: string | undefined,
): { value: string; nextIndex: number } {
  if (inline !== undefined) {
    if (inline.length === 0) {
      throw new VerificationInputError(
        `${flag} の値が空です。`,
        `${flag} <value> の形式で指定してください。`,
      );
    }
    return { value: inline, nextIndex: index };
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new VerificationInputError(
      `${flag} の値がありません。`,
      `${flag} <value> の形式で指定してください。`,
    );
  }
  return { value, nextIndex: index + 1 };
}

export function parseRunArgs(args: readonly string[]): RunOptions {
  let plan: string | undefined;
  let profile: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const separator = argument.indexOf('=');
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    const inline = separator >= 0 ? argument.slice(separator + 1) : undefined;

    switch (flag) {
      case '--plan': {
        if (plan !== undefined) {
          throw new VerificationInputError(
            '--plan が複数指定されています。',
            '--plan <path> は1回だけ指定してください。',
          );
        }
        const result = readValue(args, index, flag, inline);
        plan = result.value;
        index = result.nextIndex;
        break;
      }
      case '--profile': {
        if (profile !== undefined) {
          throw new VerificationInputError(
            '--profile が複数指定されています。',
            '--profile <path> は1回だけ指定してください。',
          );
        }
        const result = readValue(args, index, flag, inline);
        profile = result.value;
        index = result.nextIndex;
        break;
      }
      case '--json': {
        if (inline !== undefined) {
          throw new VerificationInputError(
            '--json は値を取りません。',
            '--json を単独で指定してください。',
          );
        }
        json = true;
        break;
      }
      default:
        if (argument.startsWith('-')) {
          throw new VerificationInputError(
            `未対応のオプションです: ${argument}`,
            'latch --help で利用できるオプションを確認してください。',
          );
        }
        throw new VerificationInputError(
          `未対応の引数です: ${argument}`,
          'latch run は --plan とオプションだけを受け付けます。latch --help を確認してください。',
        );
    }
  }

  if (plan === undefined) {
    throw new VerificationInputError(
      '--plan が指定されていません。',
      'latch plan --json の出力を保存し、latch run --plan <path> へ指定してください。',
    );
  }

  return { plan, ...(profile === undefined ? {} : { profile }), json };
}
