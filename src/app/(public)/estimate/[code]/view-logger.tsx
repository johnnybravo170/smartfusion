'use client';

import { useEffect } from 'react';
import { logEstimateViewAction } from '@/server/actions/estimate-approval';

export function ViewLogger({ code }: { code: string }) {
  useEffect(() => {
    const key = `estimate-view-${code}`;
    const last = sessionStorage.getItem(key);
    if (last) return;
    sessionStorage.setItem(key, String(Date.now()));
    logEstimateViewAction({
      approvalCode: code,
      sessionId: sessionStorage.getItem('hh-session') ?? undefined,
      userAgent: navigator.userAgent,
    }).catch(() => {});
  }, [code]);

  return null;
}
