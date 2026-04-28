import Link from 'next/link';
import { requireAdmin } from '@/lib/ops-gate';
import { SignOutButton } from './sign-out-button';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/worklog', label: 'Worklog' },
  { href: '/ideas', label: 'Ideas' },
  { href: '/admin/kanban', label: 'Kanban' },
  { href: '/admin/launch', label: 'Launch' },
  { href: '/admin/stats', label: 'Stats' },
  { href: '/admin/slo', label: 'SLO' },
  { href: '/decisions', label: 'Decisions' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/admin/keys', label: 'API Keys' },
  { href: '/admin/mcp', label: 'MCP' },
  { href: '/admin/audit', label: 'Audit Log' },
  { href: '/admin/memory-guide', label: 'Memory guide' },
];

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <span className="text-sm font-semibold tracking-tight">HeyHenry Ops</span>
          <nav className="flex gap-4 text-sm">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
            <span title={admin.email}>{admin.email.split('@')[0]}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
