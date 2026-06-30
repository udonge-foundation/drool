import { once } from 'lodash-es';

import { ToolRegistry } from '@industry/drool-core/tools/registry';

import { CliClientToolDependencies } from '@/tools/types';

export const getTUIToolRegistry = once(
  () => new ToolRegistry<CliClientToolDependencies>()
);
