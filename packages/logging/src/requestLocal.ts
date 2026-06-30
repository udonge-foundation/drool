import { MetaError } from './errors';
import { RequestLocalContext } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let requestLocalStorage: any;
if (typeof window === 'undefined') {
  // Only require and instantiate in Node.js
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require('node:async_hooks');
  requestLocalStorage = new AsyncLocalStorage();
}

export async function runRequestStore<T>(
  store: RequestLocalContext,
  cb: () => Promise<T>
): Promise<T> {
  if (!requestLocalStorage) {
    throw new MetaError(
      'AsyncLocalStorage is not available in this environment'
    );
  }

  return await requestLocalStorage?.run(store, cb);
}

export function getRequestStore(): RequestLocalContext | undefined {
  return requestLocalStorage?.getStore();
}
