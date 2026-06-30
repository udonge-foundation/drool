import { logWarn } from '@industry/logging';

import { PromisePoolOptions } from './types';

/**
 * Represents the result of a task execution
 */
type TaskResult<T> = {
  status: 'fulfilled' | 'rejected';
  value?: T;
  error?: Error;
  index: number;
};

/**
 * Executes an array of promises with a maximum number of concurrent executions
 * @param tasks Array of functions that return promises
 * @param concurrency Maximum number of promises to run at once
 * @param options Configuration options for error handling
 * @returns Promise that resolves with an array of results and any errors
 */
export async function promisePool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  options: PromisePoolOptions = {}
): Promise<{
  results: (T | undefined)[];
  errors: TaskResult<T>[];
}> {
  const { stopOnError = false, throwErrors = true } = options;

  const results: (T | undefined)[] = new Array(tasks.length);
  const errors: TaskResult<T>[] = [];
  let currentIndex = 0;
  const inProgress = new Set<Promise<void>>();

  // Process tasks until all are complete
  while (currentIndex < tasks.length || inProgress.size > 0) {
    // Fill the pool up to concurrency limit
    while (inProgress.size < concurrency && currentIndex < tasks.length) {
      const taskIndex = currentIndex;

      const promise = tasks[taskIndex]()
        .then((result) => {
          results[taskIndex] = result;
        })
        .catch((error) => {
          const taskError: TaskResult<T> = {
            status: 'rejected',
            error: error instanceof Error ? error : new Error(String(error)),
            index: taskIndex,
          };
          errors.push(taskError);

          if (stopOnError) {
            throw error; // Stop processing if stopOnError is true
          }
        })
        .finally(() => {
          inProgress.delete(promise);
        });

      inProgress.add(promise);
      currentIndex += 1;
    }

    // Wait for at least one promise to complete before next iteration
    if (inProgress.size > 0) {
      try {
        await Promise.race(inProgress);
      } catch (error) {
        if (stopOnError) {
          // Throw immediately if stopOnError is true
          throw error;
        }
        // Otherwise continue processing remaining tasks
        logWarn('Promise pool task failed, continuing', { cause: error });
      }
    }
  }

  // Handle collected errors based on options
  if (throwErrors && errors.length > 0) {
    const errorMessage = `${errors.length} tasks failed:\n${errors
      .map((e) => `- Task ${e.index}: ${e.error?.message}`)
      .join('\n')}`;
    throw new AggregateError(
      errors.map((e) => e.error),
      errorMessage
    );
  }

  return { results, errors };
}
