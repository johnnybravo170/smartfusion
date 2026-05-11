'use client';

import { Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { ProjectWithCategories, WorkerTimeEntry } from '@/lib/db/queries/worker-time';
import { logWorkerTimeAction, updateWorkerTimeAction } from '@/server/actions/worker-time';

type Props = {
  projects: ProjectWithCategories[];
  /** When provided, the form edits this entry instead of creating a new one. */
  initial?: WorkerTimeEntry;
};

export function WorkerTimeForm({ projects, initial }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const tz = useTenantTimezone();
  const isEdit = Boolean(initial);
  const initialProject =
    initial?.project_id ?? params?.get('project') ?? projects[0]?.project_id ?? '';
  const initialDate =
    initial?.entry_date ??
    params?.get('date') ??
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState(initialProject);
  const [categoryId, setCategoryId] = useState(initial?.budget_category_id ?? '');
  const [costLineId, setCostLineId] = useState(initial?.cost_line_id ?? '');
  const [hours, setHours] = useState(initial ? String(initial.hours) : '');
  const [date, setDate] = useState(initialDate);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const categories = useMemo(
    () => projects.find((p) => p.project_id === projectId)?.categories ?? [],
    [projects, projectId],
  );
  const costLines = useMemo(
    () => categories.find((b) => b.id === categoryId)?.cost_lines ?? [],
    [categories, categoryId],
  );

  const hasBucket = Boolean(categoryId || costLineId);
  const hasNotes = notes.trim().length > 0;
  const isEmptyContext = !hasBucket && !hasNotes;

  function submit(confirmEmpty: boolean) {
    const h = Number(hours);
    startTransition(async () => {
      const res = isEdit
        ? await updateWorkerTimeAction({
            id: initial?.id ?? '',
            project_id: projectId,
            budget_category_id: categoryId || undefined,
            cost_line_id: costLineId || undefined,
            hours: h,
            notes: notes || undefined,
            entry_date: date,
            confirm_empty: confirmEmpty || undefined,
          })
        : await logWorkerTimeAction({
            project_id: projectId,
            budget_category_id: categoryId || undefined,
            cost_line_id: costLineId || undefined,
            hours: h,
            notes: notes || undefined,
            entry_date: date,
            confirm_empty: confirmEmpty || undefined,
          });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(isEdit ? 'Time updated.' : 'Time logged.');
      router.push('/w/time');
    });
  }

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
    if (isEmptyContext) {
      setConfirmOpen(true);
      return;
    }
    submit(false);
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
            setCategoryId('');
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

      {categories.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="category">Work area</Label>
          <Select
            value={categoryId}
            onValueChange={(v) => {
              setCategoryId(v);
              setCostLineId('');
            }}
          >
            <SelectTrigger id="category">
              <SelectValue placeholder="Pick a work area" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Pick a work area or add a note below — helps the office track labour.
          </p>
        </div>
      ) : null}

      {/* Cost line picker — only shows when a category is chosen and that
          category has lines. Helps the office track labour at the line level
          (e.g. "tile install" vs the whole bathroom). Optional — the
          default is category-only. */}
      {categoryId && costLines.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="cost-line">Line item (optional)</Label>
          <Select
            value={costLineId || '__none__'}
            onValueChange={(v) => setCostLineId(v === '__none__' ? '' : v)}
          >
            <SelectTrigger id="cost-line">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">— none (whole category) —</SelectItem>
              {costLines.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.label}
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

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save without a work area or notes?</AlertDialogTitle>
            <AlertDialogDescription>
              The office can&apos;t track these hours to a specific cost line. Either pick a work
              area, jot a quick note, or save as-is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Go back</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                setConfirmOpen(false);
                submit(true);
              }}
            >
              Save anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
