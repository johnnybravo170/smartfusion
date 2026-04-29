'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type Site = {
  project_id: string;
  project_name: string;
  customer_name: string | null;
};

export function SiteSwitcher({
  current,
  options,
  basePath,
}: {
  current: Site;
  options: Site[];
  basePath: string;
}) {
  const others = options.filter((o) => o.project_id !== current.project_id);
  if (others.length === 0) {
    return <span className="truncate text-xs text-muted-foreground">{current.project_name}</span>;
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">{current.project_name}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="end">
        <p className="px-2 pt-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Switch site
        </p>
        {options.map((o) => (
          <Link
            key={o.project_id}
            href={`${basePath}?project=${o.project_id}`}
            className={cn(
              'flex flex-col rounded-sm px-2 py-1.5 text-sm hover:bg-muted',
              o.project_id === current.project_id && 'bg-muted font-medium',
            )}
          >
            <span className="truncate">{o.project_name}</span>
            {o.customer_name ? (
              <span className="truncate text-[11px] text-muted-foreground">{o.customer_name}</span>
            ) : null}
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  );
}
