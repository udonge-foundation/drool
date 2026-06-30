import { MetaError } from '@industry/logging/errors';

import { SandboxSideEffect } from './enums';
import {
  ToolExecutor,
  IndustryTool,
  ToolImplementation,
  ToolRegistryInterface,
} from './types';

const VALID_SIDE_EFFECTS = new Set<SandboxSideEffect>(
  Object.values(SandboxSideEffect)
);

function validateToolSandboxSideEffects(tool: IndustryTool): void {
  if (!Object.prototype.hasOwnProperty.call(tool, 'sideEffects')) {
    throw new MetaError('Tool is missing sandbox side-effect metadata', {
      toolId: tool.id,
    });
  }

  if (!Array.isArray(tool.sideEffects)) {
    throw new MetaError('Tool has invalid sandbox side-effect metadata', {
      toolId: tool.id,
    });
  }

  const invalid = tool.sideEffects.filter(
    (sideEffect) => !VALID_SIDE_EFFECTS.has(sideEffect)
  );
  if (invalid.length > 0) {
    throw new MetaError('Tool has invalid sandbox side-effect metadata', {
      toolId: tool.id,
      toolCallArgs: invalid.join(', '),
    });
  }
}

export class ToolRegistry<TDependencies>
  implements ToolRegistryInterface<TDependencies>
{
  private registry: Map<string, ToolImplementation<TDependencies>> = new Map();

  register(implementation: ToolImplementation<TDependencies>): void {
    validateToolSandboxSideEffects(implementation.tool);
    this.registry.set(implementation.tool.id, implementation);
  }

  /**
   * Retrieves (lazily creating, if not already created) the ToolExecutor for the given identifier.
   * Returns undefined if no executor or tool is registered for this identifier.
   */
  getExecutor(toolId: string): ToolExecutor<TDependencies> | undefined {
    const implementation = this.registry.get(toolId);
    if (!implementation) {
      return undefined;
    }
    if (!implementation.executorInstance) {
      // Create the executor lazily using the provided industry
      implementation.executorInstance =
        implementation.executorIndustry() ?? undefined;
    }
    return implementation.executorInstance;
  }

  /**
   * Retrieves the Tool definition for the given identifier.
   * Returns undefined if no such tool identifier is registered.
   */
  getTool(toolId: string): IndustryTool | undefined {
    return this.registry.get(toolId)?.tool;
  }

  /**
   * Returns all registered IndustryTool definitions.
   */
  getAllTools(): IndustryTool[] {
    return Array.from(this.registry.values()).map((impl) => impl.tool);
  }

  /**
   * Retrieves the Tool definition for the given llmId.
   * Returns undefined if no such tool llmId is registered.
   */
  getToolByLlmId(llmId: string): IndustryTool | undefined {
    for (const implementation of this.registry.values()) {
      if (implementation.tool.llmId === llmId) {
        return implementation.tool;
      }
    }
    return undefined;
  }

  unregisterTool(toolId: string): void {
    this.registry.delete(toolId);
  }
}
