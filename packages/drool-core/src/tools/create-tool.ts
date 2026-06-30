import { z } from 'zod';

import { GenericToolExecutionOutputSchema } from '@industry/common/session';

import { IndustryTool, InputJSONSchema } from './types';

type CreateToolParams = Omit<
  IndustryTool,
  'inputSchema' | 'outputSchemas' | 'isMcpTool'
> & {
  inputSchema: z.ZodType;
  // Optional schema to send to LLM (defaults to inputSchema if not provided)
  // Useful when you want to simplify what the LLM sees while keeping
  // executor flexibility to handle edge cases
  llmInputSchema?: z.ZodType;
  outputSchemas?: IndustryTool['outputSchemas'];
};

export function createTool(tool: CreateToolParams): IndustryTool {
  const inputZodSchema = tool.inputSchema;
  const llmInputZodSchema = tool.llmInputSchema ?? tool.inputSchema;
  let outputSchemas = tool.outputSchemas;
  if (!outputSchemas) {
    // we only expect tools to satisfy the result schema, as tools do not
    // need to provide updates
    outputSchemas = {
      result: GenericToolExecutionOutputSchema,
      updates: undefined,
    };
  }
  const inputJsonSchema = z.toJSONSchema(llmInputZodSchema) as InputJSONSchema;
  const newTool: IndustryTool = {
    ...tool,
    inputSchema: inputJsonSchema,
    inputZodSchema,
    outputSchemas,
    isMcpTool: false,
  };
  return newTool;
}
