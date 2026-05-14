'use client';

/**
 * Filter bar for /inbox/intake. URL-driven so views are shareable.
 * Source / disposition / search; project filter is set via the
 * project-page banner deep link (?project=<id>) and surfaced as a
 * chip rather than a dropdown.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SOURCE_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'email', label: 'Email' },
  { value: 'project_drop', label: 'Drop zone' },
  { value: 'lead_form', label: 'Lead form' },
  { value: 'voice', label: 'Voice' },
  { value: 'web_share', label: 'Web share' },
];

const DISPOSITION_OPTIONS = [
  { value: '', label: 'Needs action' },
  { value: 'pending_review', label: 'Pending review' },
  { value: 'applied', label: 'Applied' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'error', label: 'Error' },
  { value: 'all', label: 'All' },
];

export function IntakeFilters({
  defaultSource = '',
  defaultDisposition = '',
  defaultSearch = '',
}: {
  defaultSource?: string;
  defaultDisposition?: string;
  defaultSearch?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function update(name: string, value: string) {
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    if (value) next.set(name, value);
    else next.delete(name);
    startTransition(() => {
      const qs = next.toString();
      router.replace(qs ? `/inbox/intake?${qs}` : '/inbox/intake');
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[200px] grow">
        <Label htmlFor="intake-search" className="text-xs">
          Search
        </Label>
        <Input
          id="intake-search"
          type="search"
          defaultValue={defaultSearch}
          placeholder="Sender, subject, vendor, notes…"
          onChange={(e) => update('q', e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="intake-source" className="text-xs">
          Source
        </Label>
        <select
          id="intake-source"
          value={defaultSource}
          onChange={(e) => update('source', e.target.value)}
          className="block h-9 rounded-md border bg-background px-3 text-sm"
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value || 'all'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="intake-disposition" className="text-xs">
          Status
        </Label>
        <select
          id="intake-disposition"
          value={defaultDisposition}
          onChange={(e) => update('disposition', e.target.value)}
          className="block h-9 rounded-md border bg-background px-3 text-sm"
        >
          {DISPOSITION_OPTIONS.map((o) => (
            <option key={o.value || 'default'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
