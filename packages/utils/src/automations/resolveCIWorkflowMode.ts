import { CI_WORKFLOW_MODES } from '@industry/common/api/v0/automations';

import type { CIWorkflowMode } from '@industry/common/api/v0/automations';

const MODE_BY_FILENAME: ReadonlyMap<string, CIWorkflowMode> = (() => {
  const m = new Map<string, CIWorkflowMode>();
  for (const mode of CI_WORKFLOW_MODES) {
    for (const f of mode.filenames) m.set(f.toLowerCase(), mode);
  }
  return m;
})();

const MODE_BY_ID: ReadonlyMap<string, CIWorkflowMode> = (() => {
  const m = new Map<string, CIWorkflowMode>();
  for (const mode of CI_WORKFLOW_MODES) m.set(mode.id, mode);
  return m;
})();

export function resolveCIWorkflowMode(
  filePath: string | undefined
): CIWorkflowMode | undefined {
  if (!filePath) return undefined;
  const basename = filePath.split('/').pop()?.toLowerCase();
  if (!basename) return undefined;
  return MODE_BY_FILENAME.get(basename);
}

// Resolves a mode from a persisted `modeId`/`templateId` (their string values
// align with `CIWorkflowModeId`). Preferred over the filename heuristic because
// Industry-created workflows use slug filenames (e.g. `industry-<slug>.yml`) that
// don't match any canonical mode filename.
export function resolveCIWorkflowModeById(
  modeId: string | undefined
): CIWorkflowMode | undefined {
  if (!modeId) return undefined;
  return MODE_BY_ID.get(modeId);
}
