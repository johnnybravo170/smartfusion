'use client';

/**
 * One task row with click-to-edit title + status pill + due date + delete.
 * Inline edit follows the keyboard contract from PATTERNS.md §4: Enter
 * saves, Escape cancels, blur saves.
 */

import { Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TaskRow as TaskRowData } from '@/lib/db/queries/tasks';
import { cn } from '@/lib/utils';
import type { TaskStatus } from '@/lib/validators/task';
import { deleteTaskAction, updateTaskAction } from '@/server/actions/tasks';
import { TaskStatusPill } from './task-status-pill';
import { VerifyTaskButtons } from './verify-task-buttons';

function formatDue(due: string | null): string | null {
  if (!due) return null;
  // Stored as YYYY-MM-DD; render as e.g. "Apr 24" so the row stays compact.
  const [y, m, d] = due.split('-').map(Number);
  if (!y || !m || !d) return due;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function TaskRow({
  task,
  showCheckbox = false,
  isOwner = false,
}: {
  task: TaskRowData;
  showCheckbox?: boolean;
  isOwner?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [pending, startTransition] = useTransition();

  function commit() {
    setEditing(false);
    if (title.trim() === task.title) return;
    if (!title.trim()) {
      setTitle(task.title);
      return;
    }
    startTransition(async () => {
      const res = await updateTaskAction({ id: task.id, title: title.trim() });
      if (!res.ok) {
        toast.error(res.error);
        setTitle(task.title);
      }
    });
  }

  function onDelete() {
    startTransition(async () => {
      const res = await deleteTaskAction(task.id);
      if (!res.ok) toast.error(res.error);
    });
  }

  function onToggleDone() {
    const next: TaskStatus = task.status === 'done' ? 'ready' : 'done';
    startTransition(async () => {
      const { changeStatusAction } = await import('@/server/actions/tasks');
      const res = await changeStatusAction({ id: task.id, status: next });
      if (!res.ok) toast.error(res.error);
    });
  }

  const due = formatDue(task.due_date);
  const overdue =
    task.due_date &&
    task.status !== 'done' &&
    task.status !== 'verified' &&
    task.due_date < new Date().toISOString().slice(0, 10);

  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-md border bg-card px-3 py-2 text-sm',
        pending && 'opacity-60',
      )}
    >
      {showCheckbox ? (
        <input
          type="checkbox"
          checked={task.status === 'done'}
          onChange={onToggleDone}
          aria-label={task.status === 'done' ? 'Mark not done' : 'Mark done'}
          className="size-4 shrink-0 rounded border-input"
        />
      ) : null}

      <div className="flex-1 min-w-0">
        {editing ? (
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setTitle(task.title);
                setEditing(false);
              }
            }}
            className="h-7 text-sm"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={cn(
              'block w-full truncate text-left',
              task.status === 'done' && 'text-muted-foreground line-through',
            )}
          >
            {task.title}
          </button>
        )}
      </div>

      {!showCheckbox ? <TaskStatusPill taskId={task.id} currentStatus={task.status} /> : null}

      {isOwner && task.status === 'done' ? <VerifyTaskButtons taskId={task.id} compact /> : null}

      {due ? (
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            overdue ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground',
          )}
        >
          {due}
        </span>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onDelete}
        className="hidden size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 md:inline-flex"
        aria-label="Delete task"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
