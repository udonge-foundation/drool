import { createContext, type ReactNode, useContext, useMemo } from 'react';

const StaticRenderCacheContext = createContext<{ scopeKey: string } | null>(
  null
);

export function StaticRenderCacheProvider({
  scopeKey,
  children,
}: {
  scopeKey: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ scopeKey }), [scopeKey]);
  return (
    <StaticRenderCacheContext.Provider value={value}>
      {children}
    </StaticRenderCacheContext.Provider>
  );
}

export function useStaticRenderCacheScope(): { scopeKey: string } | null {
  return useContext(StaticRenderCacheContext);
}
