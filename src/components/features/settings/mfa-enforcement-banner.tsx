/**
 * Dashboard banner nudging users to enroll in MFA during the grace period
 * (or flagging them as blocked once grace has elapsed).
 *
 * Server component — reads enforcement state directly. Renders nothing
 * when the user isn't required, is already enrolled, or is unauthenticated.
 */

import { AlertTriangle, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { getMfaEnforcement } from '@/lib/auth/mfa-enforcement';

export async function MfaEnforcementBanner() {
  const snap = await getMfaEnforcement();
  if (!snap?.required || snap.enrolled) return null;

  if (snap.blocked) {
    return (
      <div className="flex items-start gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive md:px-6">
        <ShieldAlert className="size-4 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <strong>Two-factor authentication required.</strong> Sensitive actions (Stripe, team
          invites, data export) are paused until you set it up.{' '}
          <Link href="/settings/security" className="underline">
            Set up 2FA now
          </Link>
          .
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 md:px-6 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <strong>
          {snap.graceDaysRemaining > 1
            ? `${snap.graceDaysRemaining} days`
            : snap.graceDaysRemaining === 1
              ? '1 day'
              : 'Today'}{' '}
          left to set up two-factor authentication.
        </strong>{' '}
        After that, sensitive actions will be paused until it&apos;s enabled.{' '}
        <Link href="/settings/security" className="underline">
          Set it up
        </Link>
        .
      </div>
    </div>
  );
}
