'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/admin/ar/sequences', label: 'Sequences' },
  { href: '/admin/ar/contacts', label: 'Contacts' },
  { href: '/admin/ar/templates', label: 'Templates' },
];

export function ArNav() {
  const pathname = usePathname();
  return (
    <nav className="-mb-px flex gap-6 border-b" aria-label="Autoresponder sections">
      {TABS.map((t) => {
        const active = pathname?.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              'border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
              active
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
