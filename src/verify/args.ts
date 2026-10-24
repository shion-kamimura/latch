import { VerificationInputError } from './errors.js';
import type { VerifyOptions } from './types.js';

type MutableOptions = {
  base?: string;
  issueFile?: string;
  includeUntracked: string[];
  json: boolean;
};

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

export function parseVerifyArgs(args: readonly string[]): VerifyOptions {
  const options: MutableOptions = { includeUntracked: [], json: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const separator = argument.indexOf('=');
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    const inline = separator >= 0 ? argument.slice(separator + 1) : undefined;

    switch (flag) {
      case '--base': {
        if (options.base !== undefined) {
          throw new VerificationInputError(
            '--base が複数指定されています。',
            '--base <ref> は1回だけ指定してください。',
          );
        }
        const result = readValue(args, index, flag, inline);
        options.base = result.value;
        index = result.nextIndex;
        break;
      }
      case '--issue-file': {
        if (options.issueFile !== undefined) {
          throw new VerificationInputError(
            '--issue-file が複数指定されています。',
            '--issue-file <path> は1回だけ指定してください。',
          );
        }
        const result = readValue(args, index, flag, inline);
        options.issueFile = result.value;
        index = result.nextIndex;
        break;
      }
      case '--issue': {
        throw new VerificationInputError(
          '--issue によるGitHub Issue取得はこの段階では未対応です。',
          '--issue-file <path> にIssue相当のMarkdownファイルを指定してください。',
          2,
        );
      }
      case '--include-untracked': {
        const result = readValue(args, index, flag, inline);
        options.includeUntracked.push(result.value);
        index = result.nextIndex;
        break;
      }
      case '--json':
        if (inline !== undefined) {
          throw new VerificationInputError(
            '--json は値を取りません。',
            '--json を単独で指定してください。',
          );
        }
        options.json = true;
        break;
      default:
        if (argument.startsWith('-')) {
          throw new VerificationInputError(
            `未対応のオプションです: ${argument}`,
            'latch --help で利用できるオプションを確認してください。',
          );
        }
        throw new VerificationInputError(
          `未対応の引数です: ${argument}`,
          'latch verify はオプションのみを受け付けます。latch --help を確認してください。',
        );
    }
  }

  return options;
}
