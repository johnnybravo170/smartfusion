'use client';

/**
 * Public-facing error boundary (lead-gen quoting widgets at /q/[slug],
 * unauthenticated landing surfaces). Most critical of the boundaries —
 * homeowners and GC customers see this. Bad UX here costs the tenant
 * actual leads.
 *
 * Sentry: tag `error_boundary=public` so we can alert sharply on these
 * (see card 3: high-priority alert on /q/* errors).
 */

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { error_boundary: 'public' },
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 bg-white p-8 text-center">
      <h1 className="text-2xl font-semibold">Sorry — something went wrong</h1>
      <p className="text-muted-foreground max-w-md">
        We hit a snag loading this page. Please try again. If it keeps happening, contact the
        business directly.
      </p>
      <Button onClick={reset}>Try again</Button>
      {error.digest ? (
        <p className="text-muted-foreground text-xs">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}
