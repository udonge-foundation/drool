import { DaemonDroolMethod } from '@industry/common/daemon';

export const DROOL_METHOD_SET = new Set<string>(
  Object.values(DaemonDroolMethod)
);
