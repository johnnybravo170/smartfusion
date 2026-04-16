'use client';

/**
 * URL-state filters for the jobs list view (`/jobs/list`).
 *
 * Two controls: a status chip group and an optional customer <Select>.
 * Following the Track A `CustomerSearchBar` pattern, state lives in the URL
 * (`?status=&customer_id=`) so links are shareable and the browser back
 * button works.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { type JobStatus, jobStatuses, jobStatusLabels } from '@/lib/validators/job';

export type JobsCustomerOption = {
  id: string;
  name: string;
};

const ALL_CUSTOMERS = '__all__';

export function JobListFilters({ customers }: { customers: JobsCustomerOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const currentStatus = useMemo(() => {
    const raw = searchParams.get('status');
    if (!raw) return null;
    return (jobStatuses as readonly string[]).includes(raw) ? (raw as JobStatus) : null;
  }, [searchParams]);

  const currentCustomer = searchParams.get('customer_id') ?? '';

  function applyStatus(next: JobStatus | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set('status', next);
    else params.delete('status');
    startTransition(() => {
      router.replace(`/jobs/list?${params.toString()}`);
    });
  }

  function applyCustomer(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next && next !== ALL_CUSTOMERS) params.set('customer_id', next);
    else params.delete('customer_id');
    startTransition(() => {
      router.replace(`/jobs/list?${params.toString()}`);
    });
  }

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Status:
        </span>
        <FilterChip label="All" active={currentStatus === null} onClick={() => applyStatus(null)} />
        {jobStatuses.map((s) => (
          <FilterChip
            key={s}
            label={jobStatusLabels[s]}
            active={currentStatus === s}
            onClick={() => applyStatus(s)}
            data-status={s}
          />
        ))}
      </div>

      {customers.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Customer:
          </span>
          <Select value={currentCustomer || ALL_CUSTOMERS} onValueChange={applyCustomer}>
            <SelectTrigger className="w-[220px]" aria-label="Filter by customer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CUSTOMERS}>All customers</SelectItem>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  ...rest
}: {
  label: string;
  active: boolean;
  onClick: () => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button
      variant={active ? 'secondary' : 'outline'}
      size="xs"
      onClick={onClick}
      aria-pressed={active}
      className={cn(active && 'ring-1 ring-primary/20')}
      {...rest}
    >
      {label}
    </Button>
  );
}
