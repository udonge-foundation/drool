import { LOCAL_MACHINE_ID } from '@industry/common/daemon';

/**
 * Whether a scheduled automation runs on the local machine (this user's own
 * desktop daemon) rather than a remote Industry computer.
 *
 * `machineId` is the source of truth: the daemon stamps it at sync time
 * (`LOCAL_MACHINE_ID` for the local daemon, the computer's id for a computer
 * daemon) and the create path sets it from the chosen computer's `isLocal`
 * flag. We deliberately do NOT key on `computerId`: a local machine registered
 * as a custom-model (BYOM) computer stamps every automation it creates with
 * that `computerId`, so a `computerId` is present on genuinely-local
 * automations too and cannot distinguish local from remote.
 *
 * Records that predate `machineId` (or carry an empty one) fall back to the
 * legacy `computerId`-presence heuristic so their behavior is unchanged.
 */
export function isLocalAutomation(automation: {
  machineId?: string;
  computerId?: string;
}): boolean {
  if (automation.machineId) {
    return automation.machineId === LOCAL_MACHINE_ID;
  }
  return !automation.computerId;
}
