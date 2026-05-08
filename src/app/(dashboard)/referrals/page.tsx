/**
 * Referrals — "Refer & Earn" dashboard page.
 *
 * Server component that fetches the tenant's referral code, stats, and
 * history. Client interactivity lives in the child components (copy link,
 * send invite forms).
 */

import { ReferralHistory } from '@/components/features/referrals/referral-history';
import { ReferralLinkCard } from '@/components/features/referrals/referral-link-card';
import { ReferralStats } from '@/components/features/referrals/referral-stats';
import { SendReferralForm } from '@/components/features/referrals/send-referral-form';
import { requireTenant } from '@/lib/auth/helpers';
import {
  getReferralHistoryAction,
  getReferralLinkAction,
  getReferralStatsAction,
} from '@/server/actions/referrals';

export const metadata = {
  title: 'Refer & Earn — HeyHenry',
};

export default async function ReferralsPage() {
  const { tenant } = await requireTenant();
  const [linkResult, statsResult, historyResult] = await Promise.all([
    getReferralLinkAction(),
    getReferralStatsAction(),
    getReferralHistoryAction(),
  ]);

  const link = linkResult.ok ? linkResult.data : { code: '', url: '' };
  const stats = statsResult.ok
    ? statsResult.data
    : { total: 0, signed_up: 0, converted: 0, rewards: 0 };
  const history = historyResult.ok ? historyResult.data : [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Refer &amp; Earn</h1>
        <p className="text-sm text-muted-foreground">
          Share HeyHenry with other contractors and earn rewards when they sign up.
        </p>
      </header>

      <ReferralLinkCard url={link.url} code={link.code} />

      <SendReferralForm />

      <ReferralStats stats={stats} />

      <ReferralHistory referrals={history} timezone={tenant.timezone} />
    </div>
  );
}
