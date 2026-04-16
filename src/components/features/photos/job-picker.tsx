'use client';

/**
 * URL-state job picker for the `/photos-demo` preview page.
 *
 * This component is temporary: once photo upload is integrated into the job
 * detail page in Phase 1C, the demo page (and this picker) go away.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type DemoJobOption = {
  id: string;
  label: string;
};

export function JobPicker({ jobs, selected }: { jobs: DemoJobOption[]; selected: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set('job_id', value);
    } else {
      params.delete('job_id');
    }
    startTransition(() => {
      router.push(`/photos-demo?${params.toString()}`);
    });
  }

  return (
    <div className="flex max-w-sm flex-col gap-2">
      <label
        htmlFor="demo-job-picker"
        className="text-xs font-medium uppercase text-muted-foreground"
      >
        Pick a job
      </label>
      <Select value={selected ?? ''} onValueChange={handleChange} disabled={pending}>
        <SelectTrigger id="demo-job-picker">
          <SelectValue placeholder="Choose a job" />
        </SelectTrigger>
        <SelectContent>
          {jobs.length === 0 ? (
            <SelectItem value="__empty" disabled>
              No jobs yet. Create one from /jobs first.
            </SelectItem>
          ) : (
            jobs.map((j) => (
              <SelectItem key={j.id} value={j.id}>
                {j.label}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
