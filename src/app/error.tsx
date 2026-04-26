'use client';

/**
 * Root client error boundary. Catches any error thrown in client components
 * not caught by a more specific (route-group) error.tsx. Server errors and
 * root layout errors fall through to global-error.tsx.
 *
 * Sentry: tag with `error_boundary=root` so we can group separately from
 * dashboard / public errors and spot regressions in unscoped surfaces.
 */

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { error_boundary: 'root' },
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground max-w-md">
        We've been notified and are looking into it. Try again, or reload the page.
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
      {error.digest ? (
        <p className="text-muted-foreground text-xs">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}
