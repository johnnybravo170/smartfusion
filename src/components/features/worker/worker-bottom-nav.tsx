'use client';

import { CalendarDays, Clock, FolderKanban, Home, Receipt, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/w', label: 'Today', icon: Home, match: (p: string) => p === '/w' },
  {
    href: '/w/calendar',
    label: 'Calendar',
    icon: CalendarDays,
    match: (p: string) => p.startsWith('/w/calendar'),
  },
  {
    href: '/w/projects',
    label: 'Projects',
    icon: FolderKanban,
    match: (p: string) => p.startsWith('/w/projects'),
  },
  {
    href: '/w/time',
    label: 'Time',
    icon: Clock,
    match: (p: string) => p.startsWith('/w/time'),
  },
  {
    href: '/w/expenses',
    label: 'Expenses',
    icon: Receipt,
    match: (p: string) => p.startsWith('/w/expenses'),
  },
  {
    href: '/w/profile',
    label: 'Profile',
    icon: User,
    match: (p: string) => p.startsWith('/w/profile'),
  },
];

export function WorkerBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t bg-background">
      <ul className="mx-auto flex max-w-md">
        {ITEMS.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                className={cn(
                  'flex flex-col items-center gap-1 py-2 text-xs',
                  active ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <Icon className="size-5" />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
