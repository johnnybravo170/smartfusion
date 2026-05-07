'use client';

/**
 * Edit / create modal for an individual schedule task.
 *
 * Shared between the edit-existing-task flow (click a Gantt bar) and the
 * add-custom-task flow (the "+ Add task" button). Caller decides which
 * mode by passing a `task` prop or null for create mode.
 *
 * Calls updateScheduleTaskAction / createScheduleTaskAction /
 * deleteScheduleTaskAction. Page revalidates server-side on success and
 * the operator sees the updated Gantt.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { ProjectScheduleTask } from '@/lib/db/queries/project-schedule';
import {
  createScheduleTaskAction,
  deleteScheduleTaskAction,
  updateScheduleTaskAction,
} from '@/server/actions/project-schedule';

type Mode =
  | { kind: 'edit'; task: ProjectScheduleTask }
  | { kind: 'create'; projectId: string; defaultStartDate: string };

export function ScheduleTaskEditor({
  mode,
  open,
  onClose,
}: {
  mode: Mode;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const initial =
    mode.kind === 'edit'
      ? {
          name: mode.task.name,
          planned_start_date: mode.task.planned_start_date,
          planned_duration_days: mode.task.planned_duration_days,
          status: mode.task.status,
          confidence: mode.task.confidence,
          client_visible: mode.task.client_visible,
          notes: mode.task.notes ?? '',
        }
      : {
          name: '',
          planned_start_date: mode.defaultStartDate,
          planned_duration_days: 3,
          status: 'planned' as const,
          confidence: 'rough' as const,
          client_visible: true,
          notes: '',
        };

  const [name, setName] = useState(initial.name);
  const [startDate, setStartDate] = useState(initial.planned_start_date);
  const [duration, setDuration] = useState(initial.planned_duration_days);
  const [status, setStatus] = useState(initial.status);
  const [confidence, setConfidence] = useState(initial.confidence);
  const [clientVisible, setClientVisible] = useState(initial.client_visible);
  const [notes, setNotes] = useState(initial.notes);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      if (!name.trim()) {
        setError('Name is required.');
        return;
      }
      if (duration < 1) {
        setError('Duration must be at least 1 day.');
        return;
      }
      const res =
        mode.kind === 'edit'
          ? await updateScheduleTaskAction(mode.task.id, {
              name: name.trim(),
              planned_start_date: startDate,
              planned_duration_days: duration,
              status,
              confidence,
              client_visible: clientVisible,
              notes: notes.trim() || null,
            })
          : await createScheduleTaskAction(mode.projectId, {
              name: name.trim(),
              planned_start_date: startDate,
              planned_duration_days: duration,
              client_visible: clientVisible,
              notes: notes.trim() || null,
            });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  const remove = () => {
    if (mode.kind !== 'edit') return;
    if (!confirm(`Delete "${mode.task.name}"? It will be soft-deleted (recoverable).`)) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteScheduleTaskAction(mode.task.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <button
        type="button"
        aria-label="Close task editor"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-editor-title"
        className="relative w-full max-w-md rounded-lg border bg-background p-6 shadow-lg"
      >
        <h3 id="task-editor-title" className="text-base font-semibold">
          {mode.kind === 'edit' ? 'Edit task' : 'Add task'}
        </h3>

        <div className="mt-4 space-y-3">
          <label className="block text-xs font-medium">
            <span className="block text-muted-foreground">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-medium">
              <span className="block text-muted-foreground">Start date</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="block text-xs font-medium">
              <span className="block text-muted-foreground">Duration (days)</span>
              <input
                type="number"
                min={1}
                value={duration}
                onChange={(e) => setDuration(Math.max(1, Number(e.target.value) || 1))}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </label>
          </div>

          {mode.kind === 'edit' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium">
                <span className="block text-muted-foreground">Status</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as typeof status)}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="planned">Planned</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="in_progress">In progress</option>
                  <option value="done">Done</option>
                </select>
              </label>
              <label className="block text-xs font-medium">
                <span className="block text-muted-foreground">Confidence</span>
                <select
                  value={confidence}
                  onChange={(e) => setConfidence(e.target.value as typeof confidence)}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="rough">Rough draft</option>
                  <option value="firm">Firm</option>
                </select>
              </label>
            </div>
          ) : null}

          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={clientVisible}
              onChange={(e) => setClientVisible(e.target.checked)}
              className="rounded"
            />
            <span>Visible to customer on portal</span>
          </label>

          <label className="block text-xs font-medium">
            <span className="block text-muted-foreground">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>
        </div>

        {error ? (
          <p className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-2">
          {mode.kind === 'edit' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={remove}
              disabled={pending}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={pending}>
              {pending ? 'Saving…' : mode.kind === 'edit' ? 'Save' : 'Add task'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
