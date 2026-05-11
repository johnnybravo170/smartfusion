'use client';

import { ExternalLink, Loader2, Unplug, Zap } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  checkStripeStatusAction,
  createConnectOnboardingAction,
  disconnectStripeAction,
} from '@/server/actions/stripe';

type Props = {
  stripeAccountId: string | null;
  stripeOnboardedAt: string | null;
};

export function StripeConnectCard({ stripeAccountId, stripeOnboardedAt }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const stripeParam = searchParams?.get('stripe');
  const isConnected = Boolean(stripeAccountId);
  const isOnboarded = Boolean(stripeOnboardedAt);

  // Handle return from Stripe onboarding.
  useEffect(() => {
    if (stripeParam === 'success') {
      startTransition(async () => {
        const result = await checkStripeStatusAction();
        if (result.ok) {
          toast.success('Stripe account verified.');
        } else {
          toast.error(result.error);
        }
        // Remove query params.
        router.replace('/settings');
      });
    } else if (stripeParam === 'refresh') {
      toast.info('Stripe onboarding was not completed. Try again.');
      router.replace('/settings');
    }
  }, [stripeParam, router]);

  function handleConnect() {
    startTransition(async () => {
      const result = await createConnectOnboardingAction();
      if (result.ok && result.url) {
        window.location.href = result.url;
      } else if (!result.ok) {
        toast.error(result.error);
      }
    });
  }

  function handleDisconnect() {
    startTransition(async () => {
      const result = await disconnectStripeAction();
      if (result.ok) {
        toast.success('Stripe account disconnected.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="size-5" />
          Payments
        </CardTitle>
        <CardDescription>
          Connect your Stripe account to accept payments from customers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isConnected ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
              <div className="flex flex-1 flex-col gap-1">
                <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
                  Stripe connected
                </p>
                <p className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                  {stripeAccountId}
                </p>
                {isOnboarded ? (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">
                    Charges and payouts enabled.
                  </p>
                ) : (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Onboarding may be incomplete. Click below to finish setup.
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!isOnboarded && (
                <Button variant="default" size="sm" onClick={handleConnect} disabled={isPending}>
                  {isPending && <Loader2 className="size-3.5 animate-spin" />}
                  Complete onboarding
                </Button>
              )}
              <Button variant="outline" size="sm" asChild>
                <a href="https://dashboard.stripe.com" target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  Stripe Dashboard
                </a>
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-destructive">
                    <Unplug className="size-3.5" />
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect Stripe?</AlertDialogTitle>
                    <AlertDialogDescription>
                      You will not be able to send invoices until you reconnect. Existing sent
                      invoices will still be payable.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDisconnect} disabled={isPending}>
                      {isPending && <Loader2 className="size-3.5 animate-spin" />}
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Connect your Stripe account to accept credit card and bank payments. You are the
              merchant of record. Smart Fusion collects a 0.5% platform fee on each transaction.
            </p>
            <Button onClick={handleConnect} disabled={isPending}>
              {isPending && <Loader2 className="size-3.5 animate-spin" />}
              Connect Stripe
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
