import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Lightweight tab nav at the top of the job detail page. Used by both
 * `/jobs/[id]` (Overview) and `/jobs/[id]/tasks`. Distinct routes rather
 * than ?tab=... so the existing Overview server component doesn't have to
 * branch on a query param.
 */
export function JobTabs({ jobId, current }: { jobId: string; current: 'overview' | 'tasks' }) {
  const tabs: { key: 'overview' | 'tasks'; label: string; href: string }[] = [
    { key: 'overview', label: 'Overview', href: `/jobs/${jobId}` },
    { key: 'tasks', label: 'Tasks', href: `/jobs/${jobId}/tasks` },
  ];

  return (
    <nav className="flex gap-1 border-b">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            current === t.key
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
