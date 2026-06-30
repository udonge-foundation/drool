/**
 * Error classes for hooks functionality
 */

import { MetaError } from '@industry/logging/errors';

/**
 * Base error class for tool execution control flow.
 * Use this for errors that should interrupt normal execution flow
 * but are expected control flow mechanisms (not unexpected errors).
 */
export class ToolExecutionControlError extends MetaError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, metadata);
    this.name = 'ToolExecutionControlError';
  }
}

/**
 * Base error class for all hook-related errors
 */
class HookExecutionError extends ToolExecutionControlError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, metadata);
    this.name = 'HookExecutionError';
  }
}

/**
 * Error thrown when a hook requests to stop execution
 * This error should be caught and handled gracefully by the agent
 */
export class HookStopError extends HookExecutionError {
  constructor(reason: string, metadata?: Record<string, unknown>) {
    super(reason, metadata);
    this.name = 'HookStopError';
  }
}

/**
 * Error thrown when a hook requests to abort the agent entirely
 * This error should terminate the agent session
 */
export class AgentAbortError extends HookExecutionError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, metadata);
    this.name = 'AgentAbortError';
  }
}
