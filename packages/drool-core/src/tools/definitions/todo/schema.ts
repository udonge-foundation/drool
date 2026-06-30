import { z } from 'zod';

export const TODO_MAX_ITEMS_LENGTH = 50;
export const TODO_ITEM_MAX_CHAR_LENGTH = 500;

const _todoItemSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(TODO_ITEM_MAX_CHAR_LENGTH)
    .describe('The content of the todo item'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe(
      'The status of the todo item: pending (not started), in_progress (currently working on), or completed (finished)'
    ),
  priority: z
    .enum(['high', 'medium', 'low'])
    .describe('The priority level of the todo item'),
  id: z.string().describe('A unique identifier for the todo item'),
});

export type TodoItem = z.infer<typeof _todoItemSchema>;

// Schema for LLM - simplified to just string
export const todoWriteLlmInputSchema = z.object({
  todos: z.string().describe('The updated todo list'),
});

// Schema for executor - flexible to handle LLM variations
export const todoWriteInputSchema = z.object({
  todos: z
    .union([z.string(), z.array(z.unknown())])
    .describe('A string containing todo items, one item per each new line'),
});

export type TodoWriteToolInput = z.infer<typeof todoWriteInputSchema>;

export type TodoWriteToolParams = {
  todos: TodoItem[];
};

const _todoWriteResultSchema = z
  .string()
  .describe('A message indicating the status of the todo list update.');

export type TodoWriteToolResult = z.infer<typeof _todoWriteResultSchema>;
