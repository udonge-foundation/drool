import { MachineType } from '@industry/common/daemon';
import { MachineConnectionType } from '@industry/common/session';
import { logWarn, MetaError } from '@industry/logging';

/**
 * Convert MachineConnectionType to MachineType.
 *
 * Applied to persisted session data, which may still carry connection types that
 * were removed from the enum (the legacy Bridge / WorkspaceLegacy values).
 * Deprecated values map to their historical equivalents; any value that cannot be
 * classified returns `undefined`, which callers translate to an unavailable state
 * instead of throwing — so one legacy session can't crash a whole list render.
 *
 * @returns the matching MachineType, or `undefined` if it cannot be classified
 */
export function machineConnectionTypeToMachineType(
  connectionType: MachineConnectionType
): MachineType | undefined {
  switch (connectionType) {
    case MachineConnectionType.Computer:
      return MachineType.Computer;

    // TUI and the legacy Bridge connection (the old Industry Bridge app, removed
    // in #8986) are both local sessions.
    case MachineConnectionType.TUI:
    case MachineConnectionType.Bridge:
      return MachineType.Local;

    // Workspace and the legacy WorkspaceLegacy connection (removed in #9525) are
    // both remote cloud workspaces.
    case MachineConnectionType.Workspace:
    case MachineConnectionType.WorkspaceLegacy:
      return MachineType.Ephemeral;

    default: {
      const exhaustiveCheck: never = connectionType;
      logWarn('Unhandled MachineConnectionType', {
        machineConnectionType: exhaustiveCheck,
      });
      return undefined;
    }
  }
}

/**
 * Convert MachineType (daemon client enum) to MachineConnectionType (domain enum).
 *
 * Used when exposing daemon client internal state to higher-level application code.
 *
 * @param machineType - The daemon client machine type (Ephemeral, Local, Computer)
 * @returns The corresponding high-level connection type (Workspace, TUI, Computer)
 */
export function machineTypeToMachineConnectionType(
  machineType: MachineType
): MachineConnectionType {
  switch (machineType) {
    case MachineType.Computer:
      return MachineConnectionType.Computer;
    case MachineType.Local:
      return MachineConnectionType.TUI;
    case MachineType.Ephemeral:
      return MachineConnectionType.Workspace;
    default: {
      const exhaustiveCheck: never = machineType;
      throw new MetaError('Unhandled MachineType', {
        machineType: exhaustiveCheck,
      });
    }
  }
}
