import { DaemonManagementMethod } from '@industry/common/daemon';

import type {
  ManagementCapabilityDeps,
  ManagementCapabilityHostDeps,
} from './types';
import type { DaemonCapability } from '../../server/core/types';

export function createManagementCapability(
  host: ManagementCapabilityHostDeps = {}
): DaemonCapability<ManagementCapabilityDeps> {
  return {
    methods: Object.values(DaemonManagementMethod),
    buildDeps: (toolbox) => ({ env: toolbox.env, ...host }),
    load: async (deps) => {
      const { ManagementHandler } = await import(
        '../../server/handlers/management-request-handler'
      );
      return new ManagementHandler(deps.onUpdate);
    },
  };
}
