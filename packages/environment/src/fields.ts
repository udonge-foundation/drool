import { z } from 'zod';

import { IndustryEnv } from '@industry/common/environment';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

function isProductionIndustryEnv(): boolean {
  return (
    process.env.INDUSTRY_ENV?.toLowerCase().trim() === IndustryEnv.Production
  );
}

// eslint-disable-next-line industry/constants-file-organization -- envFields namespace intentionally lives in fields.ts
export const envFields = {
  required: () => z.string().min(1),

  optional: () => z.string().optional(),

  withDefault: (value: string) => z.string().default(value),

  productionRequiredString: () =>
    z
      .string()
      .optional()
      .superRefine((value, context) => {
        if (value !== undefined || !isProductionIndustryEnv()) {
          return;
        }

        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Required in production',
        });
      }),

  booleanString: () =>
    z.preprocess((value) => {
      if (value === undefined) {
        return undefined;
      }

      if (typeof value === 'boolean') {
        return value;
      }

      if (typeof value !== 'string') {
        return value;
      }

      const normalized = value.toLowerCase().trim();
      if (TRUE_VALUES.has(normalized)) {
        return true;
      }
      if (FALSE_VALUES.has(normalized)) {
        return false;
      }

      return value;
    }, z.boolean().optional()),

  numberString: () =>
    z.preprocess(
      (value) => (value === undefined ? undefined : value),
      z.coerce.number().optional()
    ),

  integerString: () =>
    z.preprocess(
      (value) => (value === undefined ? undefined : value),
      z.coerce.number().int().optional()
    ),
};
