import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import type { SubscriptionStatus } from '@/lib/billing/features';

/**
 * Trial countdown banner. Shown only while subscription_status='trialing'.
 *
 * Tone steps with urgency:
 *   >7 days  → muted info ("14-day trial — 12 days left")
 *   3-7 days → mid (sky)
 *   ≤2 days  → loud (amber, "Trial ends tomorrow")
 *
 * Links to /settings/billing so they can swap plan / confirm card without
 * waiting for the auto-charge surprise.
 */
export function TrialBanner({
  status,
  trialEndsAt,
}: {
  status: SubscriptionStatus;
  trialEndsAt: string | Date | null | undefined;
}) {
  if (status !== 'trialing' || !trialEndsAt) return null;

  const end = trialEndsAt instanceof Date ? trialEndsAt : new Date(trialEndsAt);
  const msLeft = end.getTime() - Date.now();
  if (msLeft <= 0) return null; // expired; webhook will flip status soon
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

  const urgent = daysLeft <= 2;
  const mid = daysLeft <= 7 && daysLeft > 2;

  const tone = urgent
    ? 'border-amber-300 bg-amber-50 text-amber-900'
    : mid
      ? 'border-sky-200 bg-sky-50 text-sky-900'
      : 'border-[var(--border)] bg-muted/40 text-muted-foreground';

  const label =
    daysLeft === 1
      ? 'Trial ends tomorrow'
      : daysLeft === 0
        ? 'Trial ends today'
        : `Trial ends in ${daysLeft} days`;

  const subtext = urgent
    ? 'Your card will be charged automatically. Update plan or payment now to avoid surprises.'
    : 'Pick the plan that fits before the trial ends — change anytime.';

  return (
    <div className={`flex items-center justify-between gap-3 border-b px-4 py-2 text-sm ${tone}`}>
      <div className="flex items-center gap-2">
        <Sparkles className="size-4" />
        <span>
          <strong className="font-medium">{label}.</strong>{' '}
          <span className="opacity-80">{subtext}</span>
        </span>
      </div>
      <Link
        href="/settings/billing"
        className="font-medium underline underline-offset-2 hover:no-underline"
      >
        Manage plan
      </Link>
    </div>
  );
}
