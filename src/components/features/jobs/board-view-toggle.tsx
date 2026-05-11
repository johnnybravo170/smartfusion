'use client';

/**
 * Toggle between the kanban board (`/jobs`) and the table list (`/jobs/list`).
 * Preserves existing query params when it can (status/customer filters) so a
 * user can slide between views without losing context.
 */

import { CalendarDays, KanbanSquare, Rows3 } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function BoardViewToggle() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const queryString = searchParams?.toString();
  const listHref = `/jobs/list${queryString ? `?${queryString}` : ''}`;
  const boardHref = `/jobs${queryString ? `?${queryString}` : ''}`;
  const calendarHref = `/jobs/calendar${queryString ? `?${queryString}` : ''}`;

  const listActive = pathname?.startsWith('/jobs/list');
  const calendarActive = pathname?.startsWith('/jobs/calendar');
  const boardActive = !listActive && !calendarActive;

  return (
    <div className="inline-flex items-center rounded-md border bg-card p-0.5">
      <Button
        asChild
        size="xs"
        variant={boardActive ? 'secondary' : 'ghost'}
        className={cn(boardActive && 'shadow-sm')}
      >
        <Link href={boardHref} aria-pressed={boardActive}>
          <KanbanSquare className="size-3.5" />
          Board
        </Link>
      </Button>
      <Button
        asChild
        size="xs"
        variant={listActive ? 'secondary' : 'ghost'}
        className={cn(listActive && 'shadow-sm')}
      >
        <Link href={listHref} aria-pressed={listActive}>
          <Rows3 className="size-3.5" />
          List
        </Link>
      </Button>
      <Button
        asChild
        size="xs"
        variant={calendarActive ? 'secondary' : 'ghost'}
        className={cn(calendarActive && 'shadow-sm')}
      >
        <Link href={calendarHref} aria-pressed={calendarActive}>
          <CalendarDays className="size-3.5" />
          Calendar
        </Link>
      </Button>
    </div>
  );
}
