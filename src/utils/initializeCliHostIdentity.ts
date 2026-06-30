import { getAuthedUser } from '@industry/runtime/auth';
import { initializeHostIdentityForIndustryDir } from '@industry/runtime/host';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { getRuntimeAuthConfig } from '@/environment';

export async function initializeCliHostIdentity(): Promise<void> {
  await initializeHostIdentityForIndustryDir({
    industryHome: getIndustryHome(),
    industryDirName: getIndustryDirName(),
    getAuthedUser: () => getAuthedUser(getRuntimeAuthConfig()),
  });
}
