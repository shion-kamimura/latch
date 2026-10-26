import type { PlanningCli } from './plan/llm.js';
import { getHelp } from './help.js';
import { getVersion } from './version.js';
import { parsePlanArgs } from './plan/args.js';
import { isRequirementPlanError } from './plan/errors.js';
import { planRequirements } from './plan/plan.js';
import { renderPlanJson, renderPlanText } from './plan/render.js';
import { parseRunArgs } from './run/args.js';
import { runVerification } from './run/run.js';
import { renderRunJson, renderRunText } from './run/render.js';
import { parseVerifyArgs } from './verify/args.js';
import { isVerificationInputError } from './verify/errors.js';
import { renderJson, renderText } from './verify/render.js';
import { resolveVerificationInputs } from './verify/resolve-inputs.js';

export interface RunEnvironment {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly invokeCli?: PlanningCli;
}

function verifyCommand(
  args: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
  environment: RunEnvironment,
): number {
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

async function planCommand(
  args: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
  environment: RunEnvironment,
): Promise<number> {
  const planArgs = args.slice(1);
  if (planArgs.includes('--help') || planArgs.includes('-h')) {
    io.stdout(getHelp());
    return 0;
  }

  try {
    const options = parsePlanArgs(planArgs);
    const plan = await planRequirements(options, {
      cwd: environment.cwd ?? process.cwd(),
      env: environment.env ?? process.env,
      invokeCli: environment.invokeCli,
    });
    for (const warning of plan.warnings) {
      io.stderr(`latch: 警告: ${warning}\n`);
    }
    io.stdout(options.json ? renderPlanJson(plan) : renderPlanText(plan));
    return 0;
  } catch (error) {
    if (isVerificationInputError(error)) {
      io.stderr(`latch: ${error.message}\n`);
      io.stderr(`次に: ${error.guidance}\n`);
      return error.exitCode;
    }
    if (isRequirementPlanError(error)) {
      io.stderr(`latch: ${error.message}\n`);
      io.stderr(`次に: ${error.guidance}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

async function runCommand(
  args: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
  environment: RunEnvironment,
): Promise<number> {
  const runArgs = args.slice(1);
  if (runArgs.includes('--help') || runArgs.includes('-h')) {
    io.stdout(getHelp());
    return 0;
  }

  try {
    const options = parseRunArgs(runArgs);
    const report = await runVerification(options, {
      cwd: environment.cwd ?? process.cwd(),
      env: environment.env ?? process.env,
      invokeCli: environment.invokeCli,
    });
    for (const warning of report.warnings) {
      io.stderr(`latch: 警告: ${warning}\n`);
    }
    const output = options.json ? renderRunJson(report) : renderRunText(report);
    try {
      io.stdout(output);
    } catch {
      io.stderr('latch: レポートの出力に失敗しました。\n');
      io.stderr(
        '次に: 標準出力の状態を確認し、同じ入力で再実行してください。\n',
      );
      return 2;
    }
    return report.verification === 'partial' ? 2 : 0;
  } catch (error) {
    if (isVerificationInputError(error)) {
      io.stderr(`latch: ${error.message}\n`);
      io.stderr(`次に: ${error.guidance}\n`);
      return error.exitCode;
    }
    if (isRequirementPlanError(error)) {
      io.stderr(`latch: ${error.message}\n`);
      io.stderr(`次に: ${error.guidance}\n`);
      return error.exitCode;
    }
    io.stderr('latch: 検証の実行に失敗しました。\n');
    io.stderr('次に: 入力を確認し、同じ条件で再実行してください。\n');
    return 2;
  }
}

export async function runCli(
  args: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
  environment: RunEnvironment = {},
): Promise<number> {
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
    return verifyCommand(args, io, environment);
  }

  if (args[0] === 'plan') {
    return planCommand(args, io, environment);
  }

  if (args[0] === 'run') {
    return runCommand(args, io, environment);
  }

  io.stderr('Unsupported arguments. Run latch --help for usage.\n');
  return 1;
}
