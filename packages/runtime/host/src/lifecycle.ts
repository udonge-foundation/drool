import path from 'path';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { HostIdentityService } from './HostIdentityService';

import type { HostIdentityAuthContext } from './types';
import type { ResolvedHostIdentity } from '@industry/drool-sdk-ext/protocol/host';

type AuthedUserForHostIdentity = {
  userId: string;
  orgId?: string;
};

type GetAuthedUserForHostIdentity =
  () => Promise<AuthedUserForHostIdentity | null>;

type InitializeHostIdentityParams = {
  industryHome: string;
  industryDirName: string;
  getAuthedUser: GetAuthedUserForHostIdentity;
  createService?: (industryDir: string) => {
    getHostIdentity(
      authContext?: HostIdentityAuthContext
    ): Promise<ResolvedHostIdentity>;
  };
};

let hostIdentityService: HostIdentityService | null = null;

function resolveIndustryConfigDir(
  industryHome: string,
  industryDirName: string,
  joinPath: (...paths: string[]) => string = path.join
): string {
  return joinPath(industryHome, industryDirName);
}

export function resolveDefaultIndustryConfigDir(): string {
  return resolveIndustryConfigDir(getIndustryHome(), getIndustryDirName());
}

/**
 * Returns the process-wide host identity service for the current Industry config
 * directory. The service owns all local host identity persistence details,
 * including `host.json`, legacy `computer.json` compatibility, auth-scoped
 * registration validation, and host config locking.
 */
export function getHostIdentityService(): HostIdentityService {
  hostIdentityService ??= new HostIdentityService({
    industryDir: resolveDefaultIndustryConfigDir(),
  });
  return hostIdentityService;
}

export async function getHostIdentityAuthContext(
  getAuthedUser: GetAuthedUserForHostIdentity
): Promise<HostIdentityAuthContext | undefined> {
  const user = await getAuthedUser();
  if (!user?.orgId) return undefined;
  return { userId: user.userId, firestoreOrgId: user.orgId };
}

export async function initializeHostIdentityForIndustryDir({
  industryHome,
  industryDirName,
  getAuthedUser,
  createService = (industryDir) => new HostIdentityService({ industryDir }),
}: InitializeHostIdentityParams): Promise<ResolvedHostIdentity> {
  const industryDir = resolveIndustryConfigDir(industryHome, industryDirName);
  const authContext = await getHostIdentityAuthContext(getAuthedUser);

  return createService(industryDir).getHostIdentity(authContext);
}
