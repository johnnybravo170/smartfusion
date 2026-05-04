import Link from 'next/link';
import { requireAdmin } from '@/lib/ops-gate';
import { SignOutButton } from './sign-out-button';

// Top-level nav: items used day-to-day. Less-frequent admin pages
// (memory-guide, audit log, raw API keys, MCP server config) are
// reachable directly via URL but kept out of the human nav so the
// header stays scannable.
//
// `memory-guide` is intentionally NOT here — it's a Claude/MCP surface
// (via the `ops_memory_guide` tool), not a human one. The page still
// exists at /admin/memory-guide for backward compat / testing.
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
