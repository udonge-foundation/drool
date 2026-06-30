import { EnvironmentError } from './errors';

import type { CreateEnvLoaderOptions, EnvLoader } from './types';
import type { z } from 'zod';

function freezeIfObject<TValue>(value: TValue): Readonly<TValue> {
  if (value !== null && typeof value === 'object') {
    return Object.freeze(value);
  }

  return value;
}

function getPathFromError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) {
    return 'root';
  }

  return firstIssue.path.length > 0 ? firstIssue.path.join('.') : 'root';
}

export function createEnvLoader<
  TSchema extends z.ZodTypeAny,
  TSource = unknown,
>(
  options: CreateEnvLoaderOptions<TSchema, TSource>
): EnvLoader<z.output<TSchema>> {
  let cachedValue: Readonly<z.output<TSchema>> | null = null;

  return {
    getEnv() {
      if (cachedValue !== null) {
        return cachedValue;
      }

      const source = options.getSource();
      const valueToParse =
        options.preprocess == null ? source : options.preprocess(source);
      const parsed = options.schema.safeParse(valueToParse);

      if (!parsed.success) {
        const path = getPathFromError(parsed.error);
        const firstIssue = parsed.error.issues[0];

        throw new EnvironmentError(
          `Invalid environment configuration at "${path}": ${firstIssue?.message ?? 'validation failed'}`,
          {
            path,
          }
        );
      }

      cachedValue = freezeIfObject(parsed.data);
      return cachedValue;
    },
  };
}
