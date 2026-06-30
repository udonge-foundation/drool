/**
 * Node-only spec save directory path utilities.
 *
 * Shared between the CLI (apps/cli) and the daemon (packages/daemon-core)
 * so they agree on how to resolve the `general.specSaveDir` setting and on
 * which project / user `.industry` directories are available as presets.
 */

export {
  findProjectIndustryWithinGit,
  findNearestProjectIndustryDir,
  getUserIndustryDir,
  resolveSpecSaveDirectory,
} from './paths';
