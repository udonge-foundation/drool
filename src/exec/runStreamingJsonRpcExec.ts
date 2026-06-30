import { logException } from '@industry/logging';

import { JsonRpcStreamingExecRunner } from '@/exec/streamingJsonRpcExecRunner';

/**
 * Entry point for JSON-RPC streaming exec mode.
 */

export async function runStreamingJsonRpcExec(): Promise<void> {
  const runner = new JsonRpcStreamingExecRunner();

  try {
    await runner.run();
  } catch (error) {
    logException(error, '[JsonRpc] Fatal error in streaming exec');
    process.exit(1);
  }
}
