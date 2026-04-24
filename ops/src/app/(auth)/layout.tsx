import Link from 'next/link';
import { requireAdmin } from '@/lib/ops-gate';
import { SignOutButton } from './sign-out-button';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/worklog', label: 'Worklog' },
  { href: '/ideas', label: 'Ideas' },
  { href: '/roadmap', label: 'Roadmap' },
  { href: '/admin/kanban', label: 'Kanban' },
  { href: '/admin/launch', label: 'Launch' },
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
            <span>{admin.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
