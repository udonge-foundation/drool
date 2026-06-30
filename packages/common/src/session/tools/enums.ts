export enum ToolResultSystemErrorType {
  InvalidToolIdLLMError = 'invalidToolIdLLMError',
  DroolFrameworkError = 'droolFrameworkError',
  UserRejection = 'userRejection',
  UserCancellation = 'userCancellation',
  ExecutionTimeoutError = 'executionTimeoutError',
}

export enum ToolExecutionErrorType {
  InvalidParameterLLMError = 'invalidParameterLLMError',
  EnvironmentStateError = 'environmentStateError',
  ExternalAPIError = 'externalAPIError',
  NoResultsFoundError = 'noResultsFoundError',
  ToolInternalError = 'toolInternalError',
}

export enum ToolCallConfirmationStatus {
  Pending = 'pending',
  NotRequired = 'not_required',
  Confirmed = 'confirmed',
  Rejected = 'rejected',
}

export enum ToolExecutionStatus {
  Pending = 'pending',
  Rejected = 'rejected',
  Loading = 'loading',
  Success = 'success',
  Error = 'error',
  Canceled = 'canceled',
}
