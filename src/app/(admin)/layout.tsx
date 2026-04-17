import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getCurrentUser } from '@/lib/auth/helpers';

/**
 * Admin layout — gates access to the platform admin dashboard.
 *
 * Only the email in `ADMIN_EMAIL` can view these routes. Everyone else
 * gets a 404 (not a redirect, to avoid leaking that the route exists).
 */

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!user?.email || !adminEmail || user.email !== adminEmail) {
    notFound();
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-6">
          <span className="text-lg font-semibold">HeyHenry Admin</span>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/admin" className="text-muted-foreground hover:text-foreground">
              Dashboard
            </Link>
          </nav>
        </div>
        <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
          Back to app
        </Link>
      </header>
      <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
    </div>
  );
}
