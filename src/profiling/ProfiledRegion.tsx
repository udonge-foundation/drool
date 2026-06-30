// Wraps opt-in profiler regions so React commit timings are captured only when CLI profiling is enabled.
import { Profiler, type ReactNode } from 'react';

import { getCliProfilerService } from '@/profiling/CliProfilerService';

interface ProfiledRegionProps {
  id: string;
  children: ReactNode;
}

export function ProfiledRegion({ id, children }: ProfiledRegionProps) {
  const profiler = getCliProfilerService();

  if (!profiler.isEnabled()) {
    return children;
  }

  return (
    <Profiler id={id} onRender={profiler.recordReactCommit}>
      {children}
    </Profiler>
  );
}
