'use client';

/**
 * Dashboard error boundary. Renders inside the dashboard layout shell so
 * the user keeps the sidebar / header / nav while seeing the error — feels
 * less catastrophic than the full-page root boundary.
 *
 * Sentry: tag `error_boundary=dashboard`. Tenant tags are already on the
 * scope from getCurrentTenant() / <SentryUserContext/>.
 */

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { error_boundary: 'dashboard' },
    });
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12 text-center">
      <h2 className="text-xl font-semibold">This page hit an error</h2>
      <p className="text-muted-foreground max-w-md text-sm">
        We've been notified. You can retry, or jump to another page from the sidebar.
      </p>
      <Button onClick={reset}>Try again</Button>
      {error.digest ? (
        <p className="text-muted-foreground text-xs">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}
