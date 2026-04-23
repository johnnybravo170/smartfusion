'use client';

/**
 * Multi-worker / multi-day assign dialog used by the owner calendar.
 *
 * Picks: project, worker(s), start date, end date. Submits one
 * bulkAssignDatesAction per worker. Honors the `skipWeekends` toggle
 * from the parent unless the user overrides it inside the dialog.
 */

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CalendarProject, CalendarWorker } from '@/lib/db/queries/owner-calendar';
import { bulkAssignDatesAction } from '@/server/actions/project-assignments';

function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isoDate(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

function rangeDates(start: string, end: string, skipWeekends: boolean): string[] {
  if (!start || !end) return [];
  const a = parseIso(start);
  const b = parseIso(end);
  if (b < a) return [];
  const out: string[] = [];
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (skipWeekends && (day === 0 || day === 6)) continue;
    out.push(isoDate(d));
    if (out.length > 60) break; // server cap
  }
  return out;
}

export function AssignWorkersDialog({
  open,
  onOpenChange,
  projects,
  workers,
  initialProjectId,
  initialStartDate,
  initialEndDate,
  skipWeekends: parentSkipWeekends,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: CalendarProject[];
  workers: CalendarWorker[];
  initialProjectId: string | null;
  initialStartDate: string;
  initialEndDate: string;
  skipWeekends: boolean;
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [workerIds, setWorkerIds] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const [skipWeekends, setSkipWeekends] = useState(parentSkipWeekends);
  const [pending, startTransition] = useTransition();

  // Reset whenever a fresh open kicks off.
  useEffect(() => {
    if (open) {
      setProjectId(initialProjectId ?? '');
      setWorkerIds(new Set());
      setStartDate(initialStartDate);
      setEndDate(initialEndDate);
      setSkipWeekends(parentSkipWeekends);
    }
  }, [open, initialProjectId, initialStartDate, initialEndDate, parentSkipWeekends]);

  const dates = rangeDates(startDate, endDate, skipWeekends);

  function toggleWorker(id: string) {
    setWorkerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSubmit() {
    if (!projectId) {
      toast.error('Pick a project.');
      return;
    }
    if (workerIds.size === 0) {
      toast.error('Pick at least one worker.');
      return;
    }
    if (dates.length === 0) {
      toast.error('Pick a valid date range.');
      return;
    }

    startTransition(async () => {
      let failed = 0;
      for (const wid of workerIds) {
        const res = await bulkAssignDatesAction({
          project_id: projectId,
          worker_profile_id: wid,
          dates,
        });
        if (!res.ok) failed += 1;
      }
      if (failed === 0) {
        toast.success(
          `Scheduled ${workerIds.size} ${workerIds.size === 1 ? 'worker' : 'workers'} on ${dates.length} ${dates.length === 1 ? 'day' : 'days'}.`,
        );
        onOpenChange(false);
      } else {
        toast.error(`${failed} assignment(s) failed.`);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Schedule workers</DialogTitle>
          <DialogDescription>
            Pick a project, the workers, and the date range. Existing day-assignments are
            overwritten.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="assign-project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={pending}>
              <SelectTrigger id="assign-project">
                <SelectValue placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.customer_name ? ` · ${p.customer_name}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="assign-start">Start date</Label>
              <Input
                id="assign-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={pending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="assign-end">End date</Label>
              <Input
                id="assign-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={pending}
              />
            </div>
          </div>

          <label
            htmlFor="dialog-skip-weekends"
            className="flex cursor-pointer items-center gap-2 text-sm"
          >
            <Checkbox
              id="dialog-skip-weekends"
              checked={skipWeekends}
              onCheckedChange={(v) => setSkipWeekends(v === true)}
              disabled={pending}
            />
            <span>Skip weekends</span>
          </label>

          <div className="space-y-2">
            <Label>Workers</Label>
            {workers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No workers in this tenant. Add one from Team.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {workers.map((w) => (
                  <label
                    key={w.profile_id}
                    htmlFor={`assign-w-${w.profile_id}`}
                    className="flex cursor-pointer items-center gap-2 rounded border p-2 text-sm hover:bg-muted/40"
                  >
                    <Checkbox
                      id={`assign-w-${w.profile_id}`}
                      checked={workerIds.has(w.profile_id)}
                      onCheckedChange={() => toggleWorker(w.profile_id)}
                      disabled={pending}
                    />
                    <span className="truncate">{w.display_name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {dates.length > 0
              ? `Will book ${dates.length} ${dates.length === 1 ? 'day' : 'days'} per worker.`
              : 'Pick a valid range above.'}
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={pending}>
            {pending ? 'Scheduling…' : 'Schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
