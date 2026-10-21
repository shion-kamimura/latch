import { getHelp } from './help.js';

export function runCli(
  args: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
): number {
  if (
    args.length === 0 ||
    (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))
  ) {
    io.stdout(getHelp());
    return 0;
  }

  io.stderr('Unsupported arguments. Run latch --help for usage.\n');
  return 1;
}
