import { useEffect } from 'react';

/**
 * Runs an effect only once on component mount
 */
export function useMountEffect(effect: () => void | (() => void)) {
  useEffect(effect, []);
}
