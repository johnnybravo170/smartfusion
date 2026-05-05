import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { UserMembership } from '@/lib/db/queries/memberships';
import type { VerticalNavItem } from '@/lib/verticals/load-pack';
import { QuickLogExpenseButton } from './quick-log-expense-button';
import { QuickLogTimeButton } from './quick-log-time-button';
import { MobileSidebarToggle } from './sidebar';
import { WorkspaceSwitcher } from './workspace-switcher';

type HeaderProps = {
  navItems: VerticalNavItem[];
  ownerRateCents?: number | null;
  memberships: UserMembership[];
  activeTenantId: string | null;
  isAdmin?: boolean;
};

export function Header({
  navItems,
  ownerRateCents,
  memberships,
  activeTenantId,
  isAdmin,
}: HeaderProps) {
  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      <div className="flex items-center gap-3">
        <MobileSidebarToggle navItems={navItems} />
      </div>

      <div className="flex items-center gap-2">
        <QuickLogTimeButton ownerRateCents={ownerRateCents ?? null} />
        <QuickLogExpenseButton />
        {/*
         * Single "New Project" entry per the Universal Intake decision
         * (worklog 15839262, 2026-04-22) and the smart-selection MO —
         * Henry sorts what was dropped, the operator doesn't pre-classify.
         * /projects/new accepts everything: voice memos, text threads,
         * photos, sub-trade quotes, sketches, paste, manual entry.
         */}
        <Button size="sm" className="gap-1" asChild>
          <Link href="/projects/new">
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">New Project</span>
          </Link>
        </Button>

        <WorkspaceSwitcher
          memberships={memberships}
          activeTenantId={activeTenantId}
          isAdmin={isAdmin}
        />
      </div>
    </header>
  );
}
