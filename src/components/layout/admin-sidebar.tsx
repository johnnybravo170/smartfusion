'use client';

import { BarChart3, LayoutDashboard, Mail, Users } from 'lucide-react';
import { NavLink } from './nav-link';

const ADMIN_NAV = [
  { href: '/admin/overview', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/tenants', label: 'Tenants', icon: Users },
  { href: '/admin/henry', label: 'Henry', icon: BarChart3 },
  { href: '/admin/ar/sequences', label: 'Autoresponder', icon: Mail },
  // Placeholders for later phases:
  // { href: '/admin/affiliates', label: 'Affiliates', icon: Handshake },
  // { href: '/admin/social', label: 'Social', icon: Share2 },
];

export function AdminSidebar() {
  return (
    <aside
      aria-label="Admin sidebar"
      className="hidden w-64 shrink-0 border-r bg-background md:flex md:flex-col"
    >
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <span className="text-sm font-semibold">HeyHenry</span>
        <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-600 dark:bg-red-500/20 dark:text-red-400">
          Admin
        </span>
      </div>
      <nav aria-label="Admin primary" className="flex flex-col gap-1 p-3">
        {ADMIN_NAV.map((item) => (
          <NavLink key={item.href} href={item.href} icon={item.icon}>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto border-t p-3 text-xs text-muted-foreground">
        <a href="/dashboard" className="hover:text-foreground">
          ← Back to operator dashboard
        </a>
      </div>
    </aside>
  );
}

export { ADMIN_NAV };
