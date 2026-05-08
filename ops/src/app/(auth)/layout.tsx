import Link from 'next/link';
import { requireAdmin } from '@/lib/ops-gate';
import { MobileNav } from './mobile-nav';
import { MoreMenu } from './more-menu';
import { SignOutButton } from './sign-out-button';

// Primary nav: day-to-day items. Stays in the main bar so it's
// always one click away. Six-ish entries fit comfortably; resist the
// urge to grow this list — push lower-frequency surfaces into
// MORE_NAV instead.
const PRIMARY_NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/worklog', label: 'Worklog' },
  { href: '/ideas', label: 'Ideas' },
  { href: '/admin/kanban', label: 'Kanban' },
  { href: '/decisions', label: 'Decisions' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/agents', label: 'Agents' },
  { href: '/board', label: 'Board' },
];

// Less-frequent admin surfaces. Behind a "More" disclosure so they
// don't crowd the bar. `memory-guide` is intentionally NOT here —
// it's a Claude/MCP surface (via `ops_memory_guide`), not a human
// one. The page still exists at /admin/memory-guide for direct
// access if needed.
const MORE_NAV = [
  { href: '/admin/launch', label: 'Launch' },
  { href: '/admin/stats', label: 'Stats' },
  { href: '/admin/slo', label: 'SLO' },
  { href: '/admin/keys', label: 'API Keys' },
  { href: '/admin/mcp', label: 'MCP' },
  { href: '/admin/audit', label: 'Audit Log' },
];

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 md:px-6">
          <span className="text-sm font-semibold tracking-tight">HeyHenry Ops</span>
          <nav className="hidden items-center gap-4 text-sm md:flex">
            {PRIMARY_NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {n.label}
              </Link>
            ))}
            <MoreMenu items={MORE_NAV} />
          </nav>
          <div className="ml-auto hidden items-center gap-3 text-xs text-[var(--muted-foreground)] md:flex">
            <span title={admin.email}>{admin.email.split('@')[0]}</span>
            <SignOutButton />
          </div>
          <div className="ml-auto md:hidden">
            <MobileNav primary={PRIMARY_NAV} more={MORE_NAV} email={admin.email} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">{children}</main>
    </div>
  );
}
