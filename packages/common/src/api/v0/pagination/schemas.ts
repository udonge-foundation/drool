import { z } from 'zod';

export const PaginationQuerySchema = z
  .object({
    limit: z
      .string()
      .default('20')
      .refine((val) => {
        const num = Number(val);
        return !Number.isNaN(num) && num >= 1 && num <= 100;
      }, 'Limit must be a number between 1 and 100')
      .describe('Maximum number of items to return (1-100)'),
    cursor: z.string().optional().describe('Cursor for pagination'),
  })
  .strict();

export const PaginationMetaSchema = z
  .object({
    hasMore: z
      .boolean()
      .describe('Whether there are more items after this page'),
    nextCursor: z
      .string()
      .nullable()
      .describe('Cursor to use for the next page, null if no more pages'),
  })
  .strict();
