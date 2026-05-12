'use client';

import { Clock, Loader2 } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { listActiveProjectsAction, logTimeAction } from '@/server/actions/time-entries';

type Category = { id: string; name: string; section: string };
type Project = { id: string; name: string; categories: Category[] };

export function QuickLogTimeButton({ ownerRateCents }: { ownerRateCents: number | null }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);

  const [projectId, setProjectId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState('');
  const [rate, setRate] = useState(ownerRateCents ? String(ownerRateCents / 100) : '');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const [needsEmptyConfirm, setNeedsEmptyConfirm] = useState(false);

  const categories = projects.find((p) => p.id === projectId)?.categories ?? [];

  useEffect(() => {
    if (!open) return;
    setLoadingProjects(true);
    listActiveProjectsAction().then((res) => {
      if (res.ok) setProjects(res.projects);
      setLoadingProjects(false);
    });
  }, [open]);

  function handleOpenChange(o: boolean) {
    setOpen(o);
    if (!o) {
      setProjectId('');
      setCategoryId('');
      setDate(new Date().toISOString().slice(0, 10));
      setHours('');
      setRate(ownerRateCents ? String(ownerRateCents / 100) : '');
      setNotes('');
      setError('');
      setNeedsEmptyConfirm(false);
    }
  }

  const isEmptyContext = !categoryId && !notes.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      setError('Pick a project.');
      return;
    }
    if (isEmptyContext && !needsEmptyConfirm) {
      setNeedsEmptyConfirm(true);
      setError('');
      return;
    }
    setError('');
    startTransition(async () => {
      const rateCents = rate ? Math.round(parseFloat(rate) * 100) : Number.NaN;
      if (!Number.isFinite(rateCents) || rateCents < 0) {
        setError('Rate is required so labour rolls up into the budget. Use 0 for unbilled hours.');
        return;
      }
      const res = await logTimeAction({
        project_id: projectId,
        budget_category_id: categoryId || undefined,
        entry_date: date,
        hours: parseFloat(hours),
        hourly_rate_cents: rateCents,
        notes: notes || undefined,
        confirm_empty: needsEmptyConfirm || undefined,
      });
      if (res.ok) {
        toast.success('Time logged.');
        setOpen(false);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <Clock className="size-3.5" />
          <span className="hidden sm:inline">Log time</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Log your time</AlertDialogTitle>
        </AlertDialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="ql-project" className="mb-1.5 block text-sm">
              Project
            </Label>
            {loadingProjects ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <select
                id="ql-project"
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setCategoryId('');
                }}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                required
              >
                <option value="">— select a project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {categories.length > 0 ? (
            <div>
              <Label htmlFor="ql-category" className="mb-1.5 block text-sm">
                Work area <span className="font-normal text-muted-foreground">optional</span>
              </Label>
              <select
                id="ql-category"
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  if (e.target.value) setNeedsEmptyConfirm(false);
                }}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="">— none —</option>
                {categories.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.section ? `${b.section} · ${b.name}` : b.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ql-date" className="mb-1.5 block text-sm">
                Date
              </Label>
              <Input
                id="ql-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="ql-hours" className="mb-1.5 block text-sm">
                Hours
              </Label>
              <Input
                id="ql-hours"
                type="number"
                step="0.25"
                min="0.25"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="e.g. 4"
                required
              />
            </div>
          </div>
          <div>
            <Label htmlFor="ql-rate" className="mb-1.5 block text-sm">
              Rate ($/h){' '}
              <span className="font-normal text-muted-foreground">use 0 for unbilled hours</span>
            </Label>
            <Input
              id="ql-rate"
              type="number"
              step="0.01"
              min="0"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="e.g. 75"
              required
              className="max-w-[160px]"
            />
          </div>
          <div>
            <Label htmlFor="ql-notes" className="mb-1.5 block text-sm">
              Notes <span className="font-normal text-muted-foreground">optional</span>
            </Label>
            <Input
              id="ql-notes"
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                if (e.target.value.trim()) setNeedsEmptyConfirm(false);
              }}
              placeholder="What were you working on?"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {needsEmptyConfirm && (
            <div className="rounded-md border border-amber-300/60 bg-amber-50/50 px-3 py-2 text-xs text-amber-900">
              No work area or notes set — these hours won&apos;t roll up to a cost line. Pick a work
              area, add a note, or click <span className="font-semibold">Save anyway</span>.
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button type="submit" disabled={pending || loadingProjects}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {needsEmptyConfirm ? 'Save anyway' : 'Log time'}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
