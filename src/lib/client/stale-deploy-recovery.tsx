'use client';

/**
 * Catches the two Next.js client-router errors that fire when a Server
 * Action call hits a server build the client doesn't match — usually a
 * stale tab after a deploy. Both are recoverable by a hard reload, which
 * pulls the fresh build (and re-runs middleware so an expired session
 * lands on /login instead of bouncing inside an action call).
 *
 *   1. UnrecognizedActionError — action ID was content-hashed by the old
 *      build and no longer exists. Fires on `await someAction()`.
 *   2. "An unexpected response was received from the server." — generic
 *      fetchServerAction failure, usually middleware redirecting the
 *      action POST to an HTML page (auth bounce or stale routing).
 *
 * Both surface as unhandled promise rejections from inside a transition.
 * Without this, the user sees a dead button: click submit, nothing
 * happens, the error fires invisibly, and they're stuck. With it, they
 * see a toast and the page reloads.
 *
 * Sentry: HEYHENRY-4 (UnrecognizedActionError on /login) and HEYHENRY-H
 * ("unexpected response" on /dashboard, mobile Safari).
 */

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { toast } from 'sonner';

const STALE_SIGNATURES = ['Server Action', 'unexpected response was received from the server'];

export function StaleDeployRecovery() {
  useEffect(() => {
    let reloading = false;

    function isStaleDeployError(reason: unknown): boolean {
      const message =
        reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
      return STALE_SIGNATURES.some((sig) => message.includes(sig));
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      if (reloading || !isStaleDeployError(event.reason)) return;
      reloading = true;
      // Capture explicitly so Sentry still sees recurrences even though
      // we're swallowing the default rejection. Tag separately so they
      // don't re-open the original triaged issues.
      Sentry.captureException(event.reason, {
        tags: { recovered: 'stale_deploy_reload' },
      });
      event.preventDefault();
      toast.info('App was updated — refreshing…');
      setTimeout(() => window.location.reload(), 1200);
    }

    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', onUnhandledRejection);
  }, []);

  return null;
}
