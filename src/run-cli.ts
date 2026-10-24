import { getHelp } from './help.js';
import { getVersion } from './version.js';
import { parseVerifyArgs } from './verify/args.js';
import { isVerificationInputError } from './verify/errors.js';
import { renderJson, renderText } from './verify/render.js';
import { resolveVerificationInputs } from './verify/resolve-inputs.js';

export function runCli(
  args: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
  environment: { cwd?: string } = {},
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

  if (args[0] === 'verify') {
    const verifyArgs = args.slice(1);
    if (verifyArgs.includes('--help') || verifyArgs.includes('-h')) {
      io.stdout(getHelp());
      return 0;
    }

    try {
      const options = parseVerifyArgs(verifyArgs);
      const snapshot = resolveVerificationInputs(
        options,
        environment.cwd ?? process.cwd(),
      );
      for (const warning of snapshot.warnings) {
        io.stderr(`latch: 警告: ${warning}\n`);
      }
      io.stdout(options.json ? renderJson(snapshot) : renderText(snapshot));
      return 0;
    } catch (error) {
      if (isVerificationInputError(error)) {
        io.stderr(`latch: ${error.message}\n`);
        io.stderr(`次に: ${error.guidance}\n`);
        return error.exitCode;
      }
      throw error;
    }
  }

  io.stderr('Unsupported arguments. Run latch --help for usage.\n');
  return 1;
}
