import { fetch } from '@industry/drool-core/api/fetch';

/**
 * POST to the restart endpoint for a managed computer to wake it from hibernation.
 * This must be called before attempting a WebSocket connection to managed computers.
 */
export async function ensureComputerRunning(computerId: string): Promise<void> {
  await fetch(`/api/v0/computers/${computerId}/restart`, {
    method: 'POST',
  });
}
