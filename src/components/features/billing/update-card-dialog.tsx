'use client';

/**
 * Update-card flow: server creates a SetupIntent, client confirms it inside
 * a HeyHenry-styled modal hosting Stripe's PaymentElement (the only card
 * input that's PCI-compliant — Stripe iframes the card fields). After
 * confirmation, server attaches + sets the resulting PaymentMethod as the
 * default for both the customer and the active subscription.
 */

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe as StripeClient } from '@stripe/stripe-js';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  createSetupIntentAction,
  setDefaultPaymentMethodAction,
} from '@/server/actions/billing-management';

let stripePromise: Promise<StripeClient | null> | null = null;
function getStripe(): Promise<StripeClient | null> {
  if (!stripePromise) {
    const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      // Surface clearly in dev; in prod the env var must be set in Vercel.
      console.error('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set');
      stripePromise = Promise.resolve(null);
    } else {
      stripePromise = loadStripe(key);
    }
  }
  return stripePromise;
}

export function UpdateCardDialog({
  open,
  onOpenChange,
  onUpdated,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onUpdated?: () => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setClientSecret(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    createSetupIntentAction()
      .then((result) => {
        if (result.ok) setClientSecret(result.clientSecret);
        else setError(result.error);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to start card update.'))
      .finally(() => setLoading(false));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update payment method</DialogTitle>
          <DialogDescription>
            Card details go directly to Stripe — HeyHenry never sees them. The new card replaces the
            existing one for renewals.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground py-4">Loading secure card form…</p>
        ) : error ? (
          <p className="text-sm text-destructive py-4">{error}</p>
        ) : clientSecret ? (
          <Elements
            stripe={getStripe()}
            options={{ clientSecret, appearance: { theme: 'stripe' } }}
          >
            <CardForm
              onClose={() => onOpenChange(false)}
              onSuccess={() => {
                onOpenChange(false);
                onUpdated?.();
              }}
            />
          </Elements>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CardForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    void (async () => {
      const result = await stripe.confirmSetup({
        elements,
        confirmParams: {
          // We don't need a return URL — confirmation happens inline.
          return_url: window.location.href,
        },
        redirect: 'if_required',
      });

      if (result.error) {
        toast.error(result.error.message ?? 'Card could not be saved.');
        setBusy(false);
        return;
      }
      const intent = result.setupIntent;
      const pm = intent?.payment_method;
      const paymentMethodId = typeof pm === 'string' ? pm : (pm?.id ?? null);
      if (!paymentMethodId) {
        toast.error('Stripe did not return a payment method.');
        setBusy(false);
        return;
      }
      startTransition(async () => {
        const r = await setDefaultPaymentMethodAction({ paymentMethodId });
        if (!r.ok) {
          toast.error(r.error);
          setBusy(false);
          return;
        }
        toast.success('Card updated.');
        setBusy(false);
        onSuccess();
      });
    })();
  }

  const disabled = pending || busy || !stripe || !elements;
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement options={{ layout: 'tabs' }} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={disabled}>
          Cancel
        </Button>
        <Button type="submit" disabled={disabled}>
          {disabled ? 'Saving…' : 'Save card'}
        </Button>
      </DialogFooter>
    </form>
  );
}
