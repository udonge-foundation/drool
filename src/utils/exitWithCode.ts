import { ShutdownReason } from '@/utils/enums';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

export async function exitWithCode(code: number) {
  const coordinator = getShutdownCoordinator();
  return coordinator.requestExit({
    reason: ShutdownReason.Other,
    exitCode: code,
  });
}

// Synchronous version for event handlers that can't be async
// This starts the cleanup process but doesn't wait for it
export function exitWithCodeSync(code: number) {
  // Start the async cleanup but don't await it
  void exitWithCode(code);
}
