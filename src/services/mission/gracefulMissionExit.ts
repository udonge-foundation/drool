/**
 * Graceful Mission Exit
 *
 * When the CLI TUI is closed while a mission is running, this function pauses
 * the mission runner and interrupts the active worker so it shows as "Partial"
 * in the Workers view instead of remaining stuck as "Running".
 */

import { MissionState } from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo, logWarn } from '@industry/logging';

import { getMissionFileService } from '@/services/mission/MissionFileService';
import { pauseMissionRunner } from '@/services/mission/missionRunnerOperations';
import { getSessionService } from '@/services/SessionService';

/**
 * Gracefully exit any running mission before the CLI exits.
 *
 * This should be called before appExit() to ensure workers are properly
 * interrupted and the mission state is set to Paused.
 *
 * @returns Promise that resolves when the mission is paused (or immediately if no mission is running)
 */
export async function gracefulMissionExit(): Promise<void> {
  try {
    const sessionService = getSessionService();
    const sessionId = sessionService.getCurrentSessionId();

    if (!sessionId) {
      return;
    }

    const missionSessionId = sessionService.getDecompMissionId() ?? sessionId;
    const missionFileService = getMissionFileService(missionSessionId);

    // Check if a mission exists for this session
    const exists = await missionFileService.missionExists();
    if (!exists) {
      return;
    }

    // Read current mission state
    const state = await missionFileService.readState();
    if (!state) {
      return;
    }

    // Only pause if mission is in a running state
    if (
      state.state !== MissionState.Running &&
      state.state !== MissionState.Initializing
    ) {
      return;
    }

    logInfo('[GracefulMissionExit] Pausing mission before CLI exit', {
      sessionId,
      missionSessionId,
      state: state.state,
    });

    // Pause the mission runner - this will:
    // 1. Interrupt the active worker session
    // 2. Update the feature status to pending
    // 3. Set mission state to Paused
    // 4. Log the pause to progress log
    await pauseMissionRunner(missionSessionId);

    logInfo('[GracefulMissionExit] Mission paused successfully', {
      sessionId,
    });
  } catch (error) {
    // Best effort - don't block exit if this fails
    logWarn('[GracefulMissionExit] Failed to pause mission gracefully', {
      cause: error,
    });
  }
}
