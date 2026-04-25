'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { createBillingPortalSessionAction } from '@/server/actions/billing';

/**
 * Opens a Stripe-hosted Customer Portal session in the same tab so the user
 * can update card / view invoices. We don't build that UI ourselves.
 */
export function ManagePaymentMethodButton({ disabled }: { disabled?: boolean }) {
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await createBillingPortalSessionAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      window.location.assign(result.url);
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending || disabled}
      onClick={handleClick}
    >
      {pending ? 'Opening…' : 'Manage payment method'}
    </Button>
  );
}
