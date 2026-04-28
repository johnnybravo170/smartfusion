import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
};

export function Header({ navItems, ownerRateCents, memberships, activeTenantId }: HeaderProps) {
  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      <div className="flex items-center gap-3">
        <MobileSidebarToggle navItems={navItems} />
      </div>

      <div className="flex items-center gap-2">
        <QuickLogTimeButton ownerRateCents={ownerRateCents ?? null} />
        <QuickLogExpenseButton />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="gap-1">
              <Plus className="size-3.5" />
              <span className="hidden sm:inline">New Project</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <Link href="/projects/new">Blank project</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/leads/new">From text thread</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <WorkspaceSwitcher memberships={memberships} activeTenantId={activeTenantId} />
      </div>
    </header>
  );
}
