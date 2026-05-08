import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ChatPanel } from '@/components/chat/chat-panel';
import { ChatProvider } from '@/components/chat/chat-provider';
import { ChatToggle } from '@/components/chat/chat-toggle';
import { PastDueBanner } from '@/components/features/billing/past-due-banner';
import { TrialBanner } from '@/components/features/billing/trial-banner';
import { MfaEnforcementBanner } from '@/components/features/settings/mfa-enforcement-banner';
import { FeedbackButton } from '@/components/layout/feedback-button';
import { Header } from '@/components/layout/header';
import { SidebarNav } from '@/components/layout/sidebar';
import { getCurrentTenant, getCurrentUser, isPlatformAdmin } from '@/lib/auth/helpers';
import { TenantProvider } from '@/lib/auth/tenant-context';
import { listUserMemberships } from '@/lib/db/queries/memberships';
import { getOperatorProfile } from '@/lib/db/queries/profile';
import { HenryScreenProvider } from '@/lib/henry/screen-context';
import { canadianTax } from '@/lib/providers/tax/canadian';
import { SentryUserContext } from '@/lib/sentry/sentry-user-context';
import { createClient } from '@/lib/supabase/server';
import { loadVerticalPack } from '@/lib/verticals/load-pack';

// All dashboard routes require the authenticated user's tenant context. They
// cannot be statically prerendered (would try to run Supabase client without
// request cookies). Force dynamic rendering for everything under this layout.
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // MFA gate: if the user has a verified factor but the session is still
  // aal1, bounce them to the MFA challenge before rendering anything.
  // Covers direct navigation to /dashboard with a stale-cookie session.
  const supabase = await createClient();
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === 'aal2' && aal.currentLevel === 'aal1') {
    redirect('/login/mfa');
  }

  const [tenant, currentUser] = await Promise.all([getCurrentTenant(), getCurrentUser()]);

  // Note: no email/phone verification gate. New signups land here directly
  // (zero-friction onboarding — see docs/onboarding-audit-2026-05.md).
  // Phone is verified lazily when an SMS feature is first used.
  // Subscription gating is also off — existing live tenants pre-date billing
  // and must keep their access.

  const timezone = tenant?.timezone || 'America/Vancouver';
  const vertical = tenant?.vertical || 'pressure_washing';
  const [operatorProfile, memberships, verticalPack, isAdmin, taxCtx] = await Promise.all([
    tenant && currentUser ? getOperatorProfile(tenant.id, currentUser.id) : Promise.resolve(null),
    currentUser ? listUserMemberships(currentUser.id) : Promise.resolve([]),
    loadVerticalPack(vertical),
    currentUser ? isPlatformAdmin(currentUser.id) : Promise.resolve(false),
    // Tax rate drives the auto-split chip on the Log Expense quick-action.
    // When no tenant context exists the chip is disabled (rate=0).
    tenant ? canadianTax.getCustomerFacingContext(tenant.id) : Promise.resolve(null),
  ]);
  const ownerRateCents = operatorProfile?.defaultHourlyRateCents ?? null;
  const tenantTaxRate = taxCtx?.totalRate ?? 0;
  const activeMembership = memberships.find((m) => m.isActive) ?? null;
  const accentColor = activeMembership?.accentColor ?? null;

  return (
    <HenryScreenProvider>
      <ChatProvider>
        {tenant && currentUser ? (
          <SentryUserContext
            userId={currentUser.id}
            tenantId={tenant.id}
            tenantPlan={tenant.plan}
            tenantVertical={tenant.vertical}
          />
        ) : null}
        {accentColor ? (
          <div className="h-1 w-full" style={{ backgroundColor: accentColor }} aria-hidden />
        ) : null}
        <div className="flex min-h-screen w-full overflow-x-hidden">
          <SidebarNav navItems={verticalPack.navItems} />
          <div className="flex min-h-screen min-w-0 flex-1 flex-col">
            <Header
              navItems={verticalPack.navItems}
              ownerRateCents={ownerRateCents}
              tenantTaxRate={tenantTaxRate}
              memberships={memberships}
              activeTenantId={tenant?.id ?? null}
              isAdmin={isAdmin}
            />
            {tenant ? <PastDueBanner status={tenant.subscriptionStatus} /> : null}
            {tenant ? (
              <TrialBanner status={tenant.subscriptionStatus} trialEndsAt={tenant.trialEndsAt} />
            ) : null}
            <MfaEnforcementBanner />
            <TenantProvider timezone={timezone}>
              <main className="flex-1 overflow-x-hidden p-4 pb-8 md:overflow-y-auto md:p-6 md:pb-24">
                {children}
              </main>
            </TenantProvider>
          </div>
        </div>
        <FeedbackButton />
        <ChatToggle />
        <ChatPanel />
      </ChatProvider>
    </HenryScreenProvider>
  );
}
