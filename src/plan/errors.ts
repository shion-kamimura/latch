export class RequirementPlanError extends Error {
  readonly exitCode: 1 | 2;
  readonly guidance: string;

  constructor(message: string, guidance: string, exitCode: 1 | 2 = 2) {
    super(message);
    this.name = 'RequirementPlanError';
    this.exitCode = exitCode;
    this.guidance = guidance;
  }
}

export function isRequirementPlanError(
  error: unknown,
): error is RequirementPlanError {
  return error instanceof RequirementPlanError;
}
