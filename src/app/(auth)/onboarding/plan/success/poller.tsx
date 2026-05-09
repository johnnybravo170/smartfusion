'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { checkSubscriptionStatusAction } from './actions';

const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 30_000;

/**
 * Auto-polls for the Stripe webhook to land. The webhook writes
 * `tenants.stripe_subscription_id`; once present, this component
 * navigates to /dashboard. If the webhook hasn't fired after 30s, we
 * stop polling and show a fallback so the customer doesn't sit on a
 * spinner forever.
 */
export function SubscriptionStatusPoller() {
  const router = useRouter();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    async function tick() {
      if (cancelled) return;
      const elapsed = Date.now() - startedAt;
      setElapsedMs(elapsed);

      if (elapsed > TIMEOUT_MS) {
        setTimedOut(true);
        return;
      }

      try {
        const result = await checkSubscriptionStatusAction();
        if (cancelled) return;
        if (result.active) {
          router.replace('/dashboard');
          return;
        }
      } catch {
        // Network blip — keep polling, don't surface yet.
      }

      setTimeout(tick, POLL_INTERVAL_MS);
    }

    tick();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const message = timedOut
    ? "Still working — we'll email you when it's ready."
    : elapsedMs < 3000
      ? 'Confirming your subscription…'
      : elapsedMs < 15_000
        ? 'Just a moment — Stripe is wrapping up.'
        : 'Taking longer than usual. Hang tight.';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{timedOut ? 'Almost ready' : 'Setting up your subscription'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-3">
          {!timedOut ? (
            <span
              aria-hidden
              className="inline-block size-5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
            />
          ) : null}
          <p>{message}</p>
        </div>
        {timedOut ? (
          <div className="space-y-2">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => router.refresh()}
            >
              Refresh
            </Button>
            <p className="text-xs">
              Still stuck?{' '}
              <Link href="mailto:hello@heyhenry.io" className="underline underline-offset-2">
                Email us
              </Link>{' '}
              and we&apos;ll sort it out.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
