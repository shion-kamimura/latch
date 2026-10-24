export class RequirementPlanError extends Error {
  readonly exitCode = 2;
  readonly guidance: string;

  constructor(message: string, guidance: string) {
    super(message);
    this.name = 'RequirementPlanError';
    this.guidance = guidance;
  }
}

export function isRequirementPlanError(
  error: unknown,
): error is RequirementPlanError {
  return error instanceof RequirementPlanError;
}
