/**
 * Detect whether the CLI is running in a corporate/managed environment
 * (VDI session, AD-joined machine, enterprise Industry org).
 *
 * Used to tailor error-remediation guidance: when we're confident the user
 * is in a managed environment, we can suggest contacting IT rather than
 * telling them to fiddle with local permissions they may not own.
 *
 * Detection is intentionally conservative — we only report `Likely` when
 * we have a strong, non-spoofable signal. Anything ambiguous returns
 * `Unknown`, which callers should treat as "show neutral guidance".
 */

import { IndustryTier } from '@industry/common/organization';
import { logInfo } from '@industry/logging';
import { SettingsManager } from '@industry/runtime/settings';

import { ManagedEnvironmentConfidence } from '@/utils/enums';
import type { ManagedEnvironmentSignal } from '@/utils/types';

let hasLoggedSignals = false;

/**
 * VDI / remote-session environment variables. Presence of any of these is
 * a strong indicator that we're inside a centrally-managed desktop session.
 */
function detectVdiSession(): string | null {
  const env = process.env;

  // Windows RDP / Citrix / VMware Horizon set SESSIONNAME to e.g. "RDP-Tcp#0"
  // or "ICA-tcp#0". A local console session uses "Console".
  const sessionName = env.SESSIONNAME;
  if (sessionName) {
    if (/^RDP-/i.test(sessionName)) return 'sessionname_rdp';
    if (/^ICA-/i.test(sessionName)) return 'sessionname_citrix';
  }

  // Citrix sets several env vars on connected sessions.
  if (env.CITRIX_CLIENT_NAME || env.CITRIX_HDX_CLIENT) {
    return 'citrix_env';
  }

  // VMware Horizon exposes these inside the virtual desktop.
  if (env.VMWARE_HORIZON_CLIENT_NAME || env.VIEW_CLIENT_ID) {
    return 'vmware_horizon_env';
  }

  // RDP clients typically set CLIENTNAME on the server side.
  // (Absence on a local machine; presence in RDP session.)
  if (env.CLIENTNAME && env.CLIENTNAME !== env.COMPUTERNAME) {
    return 'rdp_clientname';
  }

  return null;
}

/**
 * Windows-specific: detect that the machine is joined to an Active Directory
 * domain rather than running as a standalone workgroup PC.
 *
 * On a domain-joined machine, USERDOMAIN contains the AD domain name and is
 * different from COMPUTERNAME. On a personal PC in a workgroup, USERDOMAIN
 * equals COMPUTERNAME (both are the local machine name).
 *
 * USERDNSDOMAIN is only populated when the user is authenticated against a
 * domain, giving us a second independent signal.
 */
function detectWindowsDomainJoined(): string | null {
  if (process.platform !== 'win32') return null;

  const env = process.env;
  const userDomain = env.USERDOMAIN;
  const computerName = env.COMPUTERNAME;

  if (env.USERDNSDOMAIN) {
    return 'userdnsdomain';
  }

  if (userDomain && computerName && userDomain !== computerName) {
    return 'userdomain_differs';
  }

  // LOGONSERVER looks like "\\DC01" on domain-joined, "\\<computername>" on
  // workgroup machines.
  const logonServer = env.LOGONSERVER;
  if (logonServer && computerName) {
    const stripped = logonServer.replace(/^\\\\/, '');
    if (stripped && stripped.toUpperCase() !== computerName.toUpperCase()) {
      return 'logonserver_differs';
    }
  }

  return null;
}

/**
 * Enterprise Industry tier is our strongest server-verified signal that the
 * user works at a company with an IT department managing their setup.
 */
function detectEnterpriseOrg(): string | null {
  try {
    const tier = SettingsManager.getInstance().getOrgTier();
    if (
      tier === IndustryTier.ENTERPRISE ||
      tier === IndustryTier.PAYG_ENTERPRISE
    ) {
      return 'enterprise_org_tier';
    }
  } catch {
    // Settings may not be initialised yet (e.g., during early boot); treat
    // as "unknown" rather than failing the detection entirely.
  }
  return null;
}

/**
 * Return whether we're confident the current process is running in a
 * corporate/IT-managed environment.
 *
 * Result is not cached because env vars can change across daemon restarts
 * (e.g., user reconnects via RDP) and `getOrgTier()` is populated
 * asynchronously after login.
 */
export function detectManagedEnvironment(): ManagedEnvironmentSignal {
  const reasons: string[] = [];

  const enterpriseReason = detectEnterpriseOrg();
  if (enterpriseReason) reasons.push(enterpriseReason);

  const vdiReason = detectVdiSession();
  if (vdiReason) reasons.push(vdiReason);

  const domainReason = detectWindowsDomainJoined();
  if (domainReason) reasons.push(domainReason);

  if (reasons.length > 0 && !hasLoggedSignals) {
    hasLoggedSignals = true;
    logInfo('[detectManagedEnvironment] matched signals', {
      matches: reasons,
      platform: process.platform,
    });
  }

  return {
    confidence:
      reasons.length > 0
        ? ManagedEnvironmentConfidence.Likely
        : ManagedEnvironmentConfidence.Unknown,
    reasons,
  };
}
