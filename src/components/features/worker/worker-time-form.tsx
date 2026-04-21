'use client';

import { Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ProjectWithBuckets, WorkerTimeEntry } from '@/lib/db/queries/worker-time';
import { logWorkerTimeAction, updateWorkerTimeAction } from '@/server/actions/worker-time';

type Props = {
  projects: ProjectWithBuckets[];
  /** When provided, the form edits this entry instead of creating a new one. */
  initial?: WorkerTimeEntry;
};

export function WorkerTimeForm({ projects, initial }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const isEdit = Boolean(initial);
  const initialProject =
    initial?.project_id ?? params.get('project') ?? projects[0]?.project_id ?? '';
  const initialDate =
    initial?.entry_date ??
    params.get('date') ??
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState(initialProject);
  const [bucketId, setBucketId] = useState(initial?.bucket_id ?? '');
  const [hours, setHours] = useState(initial ? String(initial.hours) : '');
  const [date, setDate] = useState(initialDate);
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const buckets = useMemo(
    () => projects.find((p) => p.project_id === projectId)?.buckets ?? [],
    [projects, projectId],
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      toast.error('Pick a project.');
      return;
    }
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) {
      toast.error('Enter hours.');
      return;
    }
    startTransition(async () => {
      const res = isEdit
        ? await updateWorkerTimeAction({
            id: initial!.id,
            project_id: projectId,
            bucket_id: bucketId || undefined,
            hours: h,
            notes: notes || undefined,
            entry_date: date,
          })
        : await logWorkerTimeAction({
            project_id: projectId,
            bucket_id: bucketId || undefined,
            hours: h,
            notes: notes || undefined,
            entry_date: date,
          });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(isEdit ? 'Time updated.' : 'Time logged.');
      router.push('/w/time');
    });
  }

  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        You aren&apos;t assigned to any projects yet. Ask your supervisor to add you.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="project">Project</Label>
        <Select
          value={projectId}
          onValueChange={(v) => {
            setProjectId(v);
            setBucketId('');
          }}
        >
          <SelectTrigger id="project">
            <SelectValue placeholder="Pick project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.project_id} value={p.project_id}>
                {p.project_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {buckets.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="bucket">Work area (optional)</Label>
          <Select value={bucketId} onValueChange={setBucketId}>
            <SelectTrigger id="bucket">
              <SelectValue placeholder="— none —" />
            </SelectTrigger>
            <SelectContent>
              {buckets.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="hours">Hours</Label>
        <Input
          id="hours"
          type="number"
          inputMode="decimal"
          step="0.25"
          min="0.25"
          max="24"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          placeholder="e.g. 6"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="date">Date</Label>
        <Input
          id="date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="What you worked on"
        />
      </div>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        {isEdit ? 'Save changes' : 'Log time'}
      </Button>
    </form>
  );
}
