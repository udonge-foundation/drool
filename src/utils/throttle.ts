/**
 * Creates a throttled function that limits how often a function can be called.
 * Fixes race condition by capturing args in closure.
 */
export function throttle<Args extends unknown[]>(
  func: (...args: Args) => void,
  delay: number
): ((...args: Args) => void) & { flush: () => void } {
  let lastCall = 0;
  let timeout: NodeJS.Timeout | null = null;
  let pendingCall: (() => void) | null = null;

  const throttled = (...args: Args) => {
    const now = Date.now();

    // Capture args in closure to avoid race condition
    const execute = () => {
      lastCall = Date.now();
      func(...args);
      pendingCall = null;
    };

    if (now - lastCall >= delay) {
      execute();
    } else {
      // Store the closure, not the args directly
      pendingCall = execute;
      if (!timeout) {
        timeout = setTimeout(
          () => {
            if (pendingCall) {
              pendingCall();
            }
            timeout = null;
          },
          delay - (now - lastCall)
        );
      }
    }
  };

  const flushable = throttled as typeof throttled & { flush: () => void };
  flushable.flush = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (pendingCall) {
      pendingCall();
      pendingCall = null;
    }
  };

  return flushable;
}
