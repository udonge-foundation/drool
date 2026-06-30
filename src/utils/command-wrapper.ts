import { logException, logInfo } from '@industry/logging';

import { exitWithCode } from '@/utils/exitWithCode';

export async function commandWrapper(
  commandFunction: () => Promise<void>,
  cleanupFunction: () => Promise<void>
) {
  // Disable colors when not attached to a TTY (for clean log files)
  if (!process.stdout.isTTY) {
    process.env.FORCE_COLOR = '0';
  }

  // Set up signal handlers for cleanup
  let isShuttingDown = false;
  let handleSigInt: () => void;
  let handleSigTerm: () => void;

  function handleSignal(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logInfo('Cleaning up after receiving signal', { signal });

    // Remove signal listeners to prevent recursive calls
    process.removeListener('SIGINT', handleSigInt);
    process.removeListener('SIGTERM', handleSigTerm);

    // Execute cleanup and exit
    cleanupFunction()
      .then(async () => {
        await exitWithCode(0);
      })
      .catch(async (error) => {
        logException(error, 'Error during cleanup (signal handler)');
        await exitWithCode(1);
      });
  }

  // Create named handler functions after handleSignal is defined
  handleSigInt = () => handleSignal('SIGINT');
  handleSigTerm = () => handleSignal('SIGTERM');

  // Register signal handlers for this command execution
  process.on('SIGINT', handleSigInt);
  process.on('SIGTERM', handleSigTerm);

  let exitCode = 0;
  try {
    await commandFunction();
  } catch (error) {
    logException(error, 'Error running drool command');
    await cleanupFunction().catch((err) => {
      logException(err, 'Error during cleanup (after command error)');
    });
    exitCode = 1;
  } finally {
    // Clean up signal handlers before exiting
    process.removeListener('SIGINT', handleSigInt);
    process.removeListener('SIGTERM', handleSigTerm);
  }

  await exitWithCode(exitCode);
}
