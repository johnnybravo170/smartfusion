'use client';

/**
 * Quick-add row: title + optional due date inline. Pressing Enter on the
 * title field submits. Used by the project task list (one per phase) and
 * the personal todo list (top of page).
 */

import { Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TaskScope } from '@/lib/validators/task';
import { createTaskAction } from '@/server/actions/tasks';

export function TaskAddRow({
  scope,
  jobId,
  phase,
  showDueDate = true,
  placeholder = 'Add task…',
}: {
  scope: TaskScope;
  jobId?: string;
  phase?: string;
  showDueDate?: boolean;
  placeholder?: string;
}) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [pending, startTransition] = useTransition();

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const res = await createTaskAction({
        title: trimmed,
        scope,
        job_id: jobId,
        phase,
        due_date: due || undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setTitle('');
      setDue('');
    });
  }

  return (
    <form
      className="flex items-center gap-2 rounded-md border border-dashed bg-background px-3 py-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder}
        className="h-7 flex-1 border-0 px-0 shadow-none focus-visible:ring-0"
        disabled={pending}
      />
      {showDueDate ? (
        <Input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className="h-7 w-[140px] text-xs"
          disabled={pending}
          aria-label="Due date"
        />
      ) : null}
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !title.trim()}>
        Add
      </Button>
    </form>
  );
}
