import { getHelp } from './help.js';
import { getVersion } from './version.js';

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

  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    io.stdout(`${getVersion()}\n`);
    return 0;
  }

  io.stderr('Unsupported arguments. Run latch --help for usage.\n');
  return 1;
}
