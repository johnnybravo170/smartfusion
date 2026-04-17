import type { ReactNode } from 'react';
import { ChatPanel } from '@/components/chat/chat-panel';
import { ChatProvider } from '@/components/chat/chat-provider';
import { ChatToggle } from '@/components/chat/chat-toggle';
import { Header } from '@/components/layout/header';
import { SidebarNav } from '@/components/layout/sidebar';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { TenantProvider } from '@/lib/auth/tenant-context';

// All dashboard routes require the authenticated user's tenant context. They
// cannot be statically prerendered (would try to run Supabase client without
// request cookies). Force dynamic rendering for everything under this layout.
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const tenant = await getCurrentTenant();
  const businessName = tenant?.name;
  const timezone = tenant?.timezone || 'America/Vancouver';

  return (
    <ChatProvider>
      <div className="flex min-h-screen w-full">
        <SidebarNav />
        <div className="flex min-h-screen flex-1 flex-col">
          <Header businessName={businessName} />
          <TenantProvider timezone={timezone}>
            <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
          </TenantProvider>
        </div>
      </div>
      <ChatToggle />
      <ChatPanel />
    </ChatProvider>
  );
}
