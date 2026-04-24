import { Calculator, Download, FileText, LayoutDashboard, Receipt } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireBookkeeper } from '@/lib/auth/helpers';

export const dynamic = 'force-dynamic';

/**
 * Bookkeeper surface layout.
 *
 * Deliberately minimal: a left rail with 5 sections and a plain content
 * area. No chat, no dashboard widgets, no customer-facing links — a
 * bookkeeper who lands here should see only the financial surfaces
 * they need to do their job.
 *
 * Role guard: requireBookkeeper redirects pure workers to /w and
 * unauthenticated to /login. Owners + admins pass through so they can
 * test the bookkeeper view without logging out.
 */
export default async function BookkeeperLayout({ children }: { children: ReactNode }) {
  const { tenant } = await requireBookkeeper();

  const nav: Array<{ href: string; label: string; icon: typeof Receipt }> = [
    { href: '/bk', label: 'Overview', icon: LayoutDashboard },
    { href: '/bk/expenses', label: 'Expenses', icon: Receipt },
    { href: '/bk/gst', label: 'GST/HST', icon: Calculator },
    { href: '/bk/t4a', label: 'T4A / vendors', icon: FileText },
    { href: '/bk/exports', label: 'Year-end export', icon: Download },
  ];

  const isOwner = tenant.member.role === 'owner' || tenant.member.role === 'admin';

  return (
    <div className="flex min-h-screen w-full">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/20">
        <div className="border-b px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Bookkeeper</p>
          <p className="truncate text-sm font-medium">{tenant.name}</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-2 py-3">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        {isOwner ? (
          <div className="border-t px-3 py-3 text-xs text-muted-foreground">
            Viewing as owner.{' '}
            <Link href="/dashboard" className="font-medium text-foreground hover:underline">
              Back to dashboard
            </Link>
          </div>
        ) : null}
      </aside>
      <main className="flex-1 overflow-y-auto px-6 py-8">{children}</main>
    </div>
  );
}
