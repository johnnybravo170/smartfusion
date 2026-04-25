'use client';

/**
 * Self-serve cancel button + confirm dialog. Follows PATTERNS.md §3:
 * shadcn AlertDialog, transition-wrapped action, toast on error. Copy
 * is locked: no "are you sure / why are you leaving / would $X off help?"
 * dark patterns. Just the refund amount, the access end date, two buttons.
 *
 * Preview of the refund amount loads when the dialog opens so the user sees
 * the exact number BEFORE the destructive button is clickable.
 */

import { useEffect, useState, useTransition } from 'react';
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
import {
  type CancelRefundPreview,
  cancelSubscriptionAction,
  previewCancelRefund,
} from '@/server/actions/billing';

type Preview = CancelRefundPreview;

export function CancelSubscriptionButton() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setPreviewError(null);
    setLoadingPreview(true);
    previewCancelRefund()
      .then((result) => {
        if (result.ok) setPreview(result);
        else setPreviewError(result.error);
      })
      .catch((err) => {
        setPreviewError(err instanceof Error ? err.message : 'Could not load refund preview.');
      })
      .finally(() => setLoadingPreview(false));
  }, [open]);

  function handleConfirm(event: React.MouseEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await cancelSubscriptionAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const amount =
        result.refundCents > 0 ? formatCents(result.refundCents, result.currency) : null;
      toast.success(
        result.isTrial
          ? 'Trial cancelled. Access ended.'
          : amount
            ? `Cancelled. ${amount} refund on its way.`
            : 'Cancelled. Auto-renewal stopped.',
      );
      setOpen(false);
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
          Cancel subscription
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel subscription?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              {loadingPreview ? (
                <p>Calculating refund…</p>
              ) : previewError ? (
                <p className="text-destructive">{previewError}</p>
              ) : preview?.isTrial ? (
                <>
                  <p>Your trial will end immediately. No refund (no charge was made).</p>
                  <p>You'll lose access right away. Your data is preserved for 30 days.</p>
                </>
              ) : preview ? (
                <>
                  <p>
                    Cancelling will refund{' '}
                    <strong>{formatCents(preview.refundCents, preview.currency)}</strong> (
                    {preview.unusedDays} days unused of{' '}
                    {formatCents(preview.periodAmountCents, preview.currency)}) to your original
                    card.
                  </p>
                  <p>
                    Your access continues until{' '}
                    <strong>{formatAccessEnd(preview.accessEndsAt)}</strong>.
                  </p>
                </>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Never mind</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending || loadingPreview || !!previewError || !preview}
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
          >
            {pending ? 'Cancelling…' : 'Cancel subscription'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function formatAccessEnd(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
