import { DaemonSettingsMethod } from '@industry/common/daemon';

import type { DaemonCapability } from '../../server/core/types';

export function createSettingsCapability(): DaemonCapability {
  return {
    methods: Object.values(DaemonSettingsMethod),
    buildDeps: (toolbox) => ({ env: toolbox.env }),
    load: async () => {
      const { SettingsHandler } = await import(
        '../../server/handlers/settings-request-handler'
      );
      return new SettingsHandler();
    },
  };
}
