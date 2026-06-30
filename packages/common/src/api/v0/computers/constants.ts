// Computer IDs are UUID v4
import { ProvisioningStepId } from './enums';

export const COMPUTER_ID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/**
 * Default username for SSH connections to remote computers.
 * This user is created during computer provisioning and has SSH keys installed.
 */
export const DEFAULT_REMOTE_USER = 'industry-user';

/** Filename for the local computer registration config used by the daemon to connect to relay. */
export const COMPUTER_CONFIG_FILENAME = 'computer.json';

/**
 * Path to the drool environment file on managed computers. The Industry
 * daemon's systemd unit reads it via `EnvironmentFile=`, so provisioning
 * writes here and the template scrub flow clears it from the same path.
 */
export const DROOL_ENV_FILE = '/etc/drool/environment';

/**
 * Path to a profile.d drop-in that loads DROOL_ENV_FILE into interactive and
 * SSH login shells.
 *
 * systemd's `EnvironmentFile=` only reaches the daemon process -- not login
 * shells (sshd/PAM and the shell profiles do not read DROOL_ENV_FILE).
 * Without this an interactive `drool` started over SSH sees no INDUSTRY_API_KEY,
 * falls back to an interactive sign-in, and writes shared WorkOS credentials
 * into ~/.industry that then shadow the daemon's baked API key -- stranding the
 * computer once that WorkOS session expires.
 */
export const DROOL_PROFILE_SCRIPT_PATH = '/etc/profile.d/drool-env.sh';

/**
 * Shell snippet that loads DROOL_ENV_FILE into the current shell. Guards on
 * readability so it no-ops after the scrub flow removes the env file, and uses
 * `set -a` so the sourced variables are exported. Shared by the provisioning
 * profile.d drop-in and the daemon's login-shell self-heal so both stay in
 * sync.
 */
export const DROOL_ENV_SHELL_SNIPPET = `if [ -r ${DROOL_ENV_FILE} ]; then
  set -a
  . ${DROOL_ENV_FILE}
  set +a
fi`;

/** User-facing message when an organization exceeds its monthly compute usage limit. */
export const COMPUTE_LIMIT_EXCEEDED_MESSAGE =
  'Your organization has reached its monthly compute usage limit. Please try again next month or contact support to increase your limit.';

export const MANAGED_COMPUTERS_DOCS_URL =
  'https://docs.example.com/cli/features/drool-computers#managed-computers';

/**
 * Hand-tuned per-step "work weights" so the wizard progress bar
 * tracks real wall-clock duration rather than step count. Most setup
 * steps complete in seconds; repo cloning takes tens of seconds; the
 * autonomous install-deps Drool session can run for several minutes.
 * Without weighting, the bar would pin near 90% within seconds and
 * then sit there for minutes.
 *
 * Imported by the backend (when sequencing steps) and the frontend
 * (when interpolating the bar locally on a 1s ticker — the wire only
 * carries the current step, so the frontend needs the weights and
 * durations to fake smooth motion between snapshots).
 */
export const PROVISIONING_STEP_WEIGHTS: Record<ProvisioningStepId, number> = {
  [ProvisioningStepId.CreateComputer]: 1,
  [ProvisioningStepId.SetupUser]: 1,
  [ProvisioningStepId.InstallDroolBinary]: 1,
  [ProvisioningStepId.ConfigureEnvironment]: 1,
  [ProvisioningStepId.ConfigureCredentials]: 1,
  [ProvisioningStepId.SetupDrool]: 1,
  [ProvisioningStepId.StartServices]: 1,
  [ProvisioningStepId.CloneRepos]: 2,
  [ProvisioningStepId.InstallDeps]: 10,
};

/**
 * Per-step expected wall-clock duration (ms). Used to interpolate the
 * "running" credit on the bar so it visibly moves during long-running
 * steps rather than camping at one percent for minutes.
 *
 * The interpolation always caps at 90% of the step's weight so the
 * bar can't reach 100% before the step actually completes — the
 * remaining 10% only appears once the next snapshot transitions the
 * step out of Running.
 */
export const PROVISIONING_STEP_DURATION_MS: Record<ProvisioningStepId, number> =
  {
    [ProvisioningStepId.CreateComputer]: 30_000,
    [ProvisioningStepId.SetupUser]: 30_000,
    [ProvisioningStepId.InstallDroolBinary]: 30_000,
    [ProvisioningStepId.ConfigureEnvironment]: 30_000,
    [ProvisioningStepId.ConfigureCredentials]: 30_000,
    [ProvisioningStepId.SetupDrool]: 30_000,
    [ProvisioningStepId.StartServices]: 30_000,
    [ProvisioningStepId.CloneRepos]: 60_000,
    // Tuned long on purpose: install-deps duration varies wildly
    // across repos (a tiny Node app vs. a polyglot monorepo with
    // native deps). Erring high keeps the bar moving smoothly through
    // the typical case and prevents it from camping at the 90% cap.
    [ProvisioningStepId.InstallDeps]: 20 * 60_000,
  };
