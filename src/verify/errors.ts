export class VerificationInputError extends Error {
  readonly exitCode: 1 | 2;
  readonly guidance: string;

  constructor(message: string, guidance: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'VerificationInputError';
    this.exitCode = exitCode;
    this.guidance = guidance;
  }
}

export function isVerificationInputError(
  error: unknown,
): error is VerificationInputError {
  return error instanceof VerificationInputError;
}
