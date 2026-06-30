export enum ComputerProviderType {
  Byom = 'byom',
  E2B = 'e2b',
}

export enum ComputerStatus {
  Provisioning = 'provisioning',
  Active = 'active',
  Error = 'error',
}

export enum ComputerProviderStatus {
  Running = 'running',
  Paused = 'paused',
}

export enum ProvisioningStepStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

/**
 * Discriminator for a computer's non-scratch source. Scratch-created
 * computers omit `computerSource` entirely.
 */
export enum ComputerSource {
  Template = 'template',
  Computer = 'computer',
}

export enum ProvisioningStepId {
  CreateComputer = 'create-computer',
  SetupDrool = 'setup-drool',
  SetupUser = 'setup-user',
  InstallDroolBinary = 'install-drool-binary',
  ConfigureEnvironment = 'configure-environment',
  ConfigureCredentials = 'configure-credentials',
  StartServices = 'start-services',
  /** Clone user-selected repositories after services start. No-op when `repos` is empty. */
  CloneRepos = 'clone-repos',
  /**
   * Spawn a Drool session that installs project dependencies. Tracked
   * server-side only (the wire surfaces step state as plain strings via
   * `currentProvisioningStep`/`provisioningStepIndex`/`provisioningStepCount`),
   * so adding values here is safe for already-deployed daemons.
   */
  InstallDeps = 'install-deps',
}
