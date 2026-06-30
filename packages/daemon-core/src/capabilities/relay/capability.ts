import { DaemonRelayMethod } from '@industry/common/daemon';

import type { RelayCapabilityDeps, RelayCapabilityHostDeps } from './types';
import type { DaemonCapability } from '../../server/core/types';

export function createRelayCapability(
  host: RelayCapabilityHostDeps
): DaemonCapability<RelayCapabilityDeps> {
  return {
    methods: Object.values(DaemonRelayMethod),
    buildDeps: (toolbox) => ({ env: toolbox.env, ...host }),
    load: async (deps) => {
      const { RelayRequestHandler } = await import(
        '../../server/handlers/relay-request-handler'
      );
      return new RelayRequestHandler(
        deps.relayControl,
        deps.env.runtimeAuthConfig
      );
    },
  };
}
