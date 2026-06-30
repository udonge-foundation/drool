import { ProvisioningStepId } from '@industry/common/api/v0/computers';

const PROVISIONING_STEP_OPTIONAL: Record<ProvisioningStepId, boolean> = {
  [ProvisioningStepId.CreateComputer]: false,
  [ProvisioningStepId.SetupUser]: false,
  [ProvisioningStepId.InstallDroolBinary]: false,
  [ProvisioningStepId.ConfigureEnvironment]: false,
  [ProvisioningStepId.ConfigureCredentials]: false,
  [ProvisioningStepId.SetupDrool]: false,
  [ProvisioningStepId.StartServices]: false,
  [ProvisioningStepId.CloneRepos]: false,
  [ProvisioningStepId.InstallDeps]: true,
};

export function isStepOptional(id: ProvisioningStepId): boolean {
  return PROVISIONING_STEP_OPTIONAL[id];
}
