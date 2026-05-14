'use client';

/**
 * Path-based tab nav for the Inbox layout. Uses usePathname so the
 * active tab is highlighted regardless of how the user got there.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Tab = { key: 'intake' | 'todos' | 'worklog'; label: string; href: string; count: number };

export function InboxTabNav({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname() ?? '';

  return (
    <nav aria-label="Inbox tabs" className="flex gap-1 border-b">
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">({t.count})</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
