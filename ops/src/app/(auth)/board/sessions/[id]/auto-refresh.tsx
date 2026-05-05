'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Polls the page during a live session. router.refresh() re-runs the
 * server component fetches without changing the URL. Stops automatically
 * when this component unmounts (i.e. on navigation away or status change).
 */
export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return null;
}
