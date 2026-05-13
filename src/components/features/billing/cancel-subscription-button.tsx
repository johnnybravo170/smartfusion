'use client';

/**
 * Self-serve cancel flow with exit-survey + pause-for-30 alternative.
 *
 * Two-step dialog:
 *   1. Refund preview + pause-for-30-days CTA + "Continue cancelling" button.
 *   2. Reason picker (radios) + optional comment + final destructive button.
 *
 * Reason+comment ride along with `cancelSubscriptionAction` and are
 * appended to the `refunds_log.notes` row for audit. Pause uses
 * `subscriptions.update({ pause_collection })` for 30 days.
 *
 * Access-end and pause-resume dates render in the tenant's timezone via
 * `useTenantTimezone()` so the wording lines up with the invoice and the
 * /settings/billing page.
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import {
  type CancelReason,
  type CancelRefundPreview,
  cancelSubscriptionAction,
  previewCancelRefund,
} from '@/server/actions/billing';
import { pauseSubscriptionAction } from '@/server/actions/billing-management';

type Preview = CancelRefundPreview;

type Step = 'intro' | 'survey';

const REASONS: Array<{ value: CancelReason; label: string }> = [
  { value: 'too_expensive', label: 'Too expensive' },
  { value: 'missing_features', label: 'Missing features I need' },
  { value: 'switching_tools', label: 'Switching to another tool' },
  { value: 'business_change', label: 'Business changed (closed / sold / pivoted)' },
  { value: 'temporary_break', label: 'Just need a temporary break' },
  { value: 'too_complex', label: 'Too complicated to use' },
  { value: 'other', label: 'Other' },
];

export function CancelSubscriptionButton() {
  const tz = useTenantTimezone();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('intro');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [comment, setComment] = useState('');
  const [pending, startTransition] = useTransition();
  const [pausing, startPause] = useTransition();

  useEffect(() => {
    if (!open) return;
    setStep('intro');
    setPreview(null);
    setPreviewError(null);
    setReason(null);
    setComment('');
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

  function handlePause() {
    startPause(async () => {
      const r = await pauseSubscriptionAction();
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Paused. Resumes ${formatAccessEnd(r.resumesAtIso, tz)}.`);
      setOpen(false);
    });
  }

  function handleConfirm(event: React.MouseEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await cancelSubscriptionAction({
        reason: reason ?? undefined,
        comment: comment || undefined,
      });
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
        {step === 'intro' ? (
          <>
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
                        <strong>{formatAccessEnd(preview.accessEndsAt, tz)}</strong>.
                      </p>
                    </>
                  ) : null}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>

            {preview && !preview.isTrial ? (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-2">
                <p className="font-medium">Just need a break?</p>
                <p className="text-muted-foreground">
                  Pause billing for 30 days. Access pauses too — your data stays put. Resume
                  anytime.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handlePause}
                  disabled={pausing || pending}
                >
                  {pausing ? 'Pausing…' : 'Pause for 30 days'}
                </Button>
              </div>
            ) : null}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending || pausing}>Never mind</AlertDialogCancel>
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={pending || pausing || loadingPreview || !!previewError || !preview}
                onClick={() => setStep('survey')}
              >
                Continue cancelling
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>One quick question</AlertDialogTitle>
              <AlertDialogDescription>
                What's driving the cancellation? Helps us figure out what to fix next.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-3 py-1">
              <div role="radiogroup" className="space-y-2 text-sm">
                {REASONS.map((r) => (
                  <label
                    key={r.value}
                    className="flex items-center gap-2 cursor-pointer"
                    htmlFor={`cancel-reason-${r.value}`}
                  >
                    <input
                      type="radio"
                      id={`cancel-reason-${r.value}`}
                      name="cancel-reason"
                      value={r.value}
                      checked={reason === r.value}
                      onChange={() => setReason(r.value)}
                      className="size-4"
                    />
                    <span>{r.label}</span>
                  </label>
                ))}
              </div>
              <div>
                <Label htmlFor="cancel-comment" className="text-sm">
                  Anything else? (optional)
                </Label>
                <Textarea
                  id="cancel-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="A sentence or two helps a lot"
                  rows={3}
                  maxLength={500}
                  className="mt-1"
                />
              </div>
            </div>

            <AlertDialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('intro')}
                disabled={pending}
              >
                Back
              </Button>
              <AlertDialogAction
                onClick={handleConfirm}
                disabled={pending}
                className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              >
                {pending ? 'Cancelling…' : 'Cancel subscription'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
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

function formatAccessEnd(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}
