import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ChatPanel } from '@/components/chat/chat-panel';
import { ChatProvider } from '@/components/chat/chat-provider';
import { ChatToggle } from '@/components/chat/chat-toggle';
import { MfaEnforcementBanner } from '@/components/features/settings/mfa-enforcement-banner';
import { Header } from '@/components/layout/header';
import { SidebarNav } from '@/components/layout/sidebar';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { TenantProvider } from '@/lib/auth/tenant-context';
import { getOperatorProfile } from '@/lib/db/queries/profile';
import { HenryScreenProvider } from '@/lib/henry/screen-context';
import { createClient } from '@/lib/supabase/server';

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
  const businessName = tenant?.name;
  const timezone = tenant?.timezone || 'America/Vancouver';
  const vertical = tenant?.vertical || 'pressure_washing';
  const operatorProfile =
    tenant && currentUser ? await getOperatorProfile(tenant.id, currentUser.id) : null;
  const ownerRateCents = operatorProfile?.defaultHourlyRateCents ?? null;

  return (
    <HenryScreenProvider>
      <ChatProvider>
        <div className="flex min-h-screen w-full overflow-x-hidden">
          <SidebarNav vertical={vertical} />
          <div className="flex min-h-screen min-w-0 flex-1 flex-col">
            <Header
              businessName={businessName}
              vertical={vertical}
              ownerRateCents={ownerRateCents}
            />
            <MfaEnforcementBanner />
            <TenantProvider timezone={timezone}>
              <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 pb-28 md:p-6 md:pb-24">
                {children}
              </main>
            </TenantProvider>
          </div>
        </div>
        <ChatToggle />
        <ChatPanel />
      </ChatProvider>
    </HenryScreenProvider>
  );
}
