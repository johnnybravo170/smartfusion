/**
 * Referrals — "Refer & Earn" dashboard page.
 *
 * Server component that fetches the tenant's referral code, stats, and
 * history. Client interactivity lives in the child components (copy link,
 * send invite forms).
 */

import { AffiliateOfferCard } from '@/components/features/referrals/affiliate-offer-card';
import { ReferralHistory } from '@/components/features/referrals/referral-history';
import { ReferralLinkCard } from '@/components/features/referrals/referral-link-card';
import { ReferralStats } from '@/components/features/referrals/referral-stats';
import { SendReferralForm } from '@/components/features/referrals/send-referral-form';
import { requireTenant } from '@/lib/auth/helpers';
import {
  getAffiliateTierAction,
  getReferralHistoryAction,
  getReferralLinkAction,
  getReferralStatsAction,
} from '@/server/actions/referrals';

export const metadata = {
  title: 'Refer & Earn — HeyHenry',
};

export default async function ReferralsPage() {
  const { tenant } = await requireTenant();
  const [linkResult, statsResult, historyResult, tierResult] = await Promise.all([
    getReferralLinkAction(),
    getReferralStatsAction(),
    getReferralHistoryAction(),
    getAffiliateTierAction(),
  ]);

  const link = linkResult.ok ? linkResult.data : { code: '', url: '' };
  const stats = statsResult.ok
    ? statsResult.data
    : { total: 0, signed_up: 0, converted: 0, rewards: 0 };
  const history = historyResult.ok ? historyResult.data : [];
  const tier = tierResult.ok ? tierResult.data : 'tier_3';

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Refer &amp; Earn</h1>
        <p className="text-sm text-muted-foreground">
          {tier === 'tier_3'
            ? 'Share HeyHenry with other contractors and earn $300 for every one who becomes a paying customer.'
            : 'Share HeyHenry with other contractors. Your commission terms are covered by your partner agreement.'}
        </p>
      </header>

      <AffiliateOfferCard tier={tier} />

      <ReferralLinkCard url={link.url} code={link.code} />

      <SendReferralForm />

      <ReferralStats stats={stats} />

      <ReferralHistory referrals={history} timezone={tenant.timezone} />
    </div>
  );
}
