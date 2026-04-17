'use client';

import { createContext, useContext } from 'react';

type TenantContextValue = {
  timezone: string;
};

const TenantContext = createContext<TenantContextValue>({
  timezone: 'America/Vancouver',
});

export function TenantProvider({
  timezone,
  children,
}: {
  timezone: string;
  children: React.ReactNode;
}) {
  return <TenantContext.Provider value={{ timezone }}>{children}</TenantContext.Provider>;
}

export function useTenantTimezone(): string {
  return useContext(TenantContext).timezone;
}
