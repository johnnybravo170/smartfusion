'use client';

/**
 * Click-to-edit project.start_date control. Used on the Schedule tab
 * because that's where the date matters most — it anchors the entire
 * Gantt timeline. Mirrors `<ProjectNameEditor>`'s inline editing
 * pattern.
 *
 * Empty state ("Project start: not set") triggers a one-click "Set
 * start date" flow so a brand-new project can anchor its timeline
 * without leaving the Schedule tab.
 */

import { Check, Pencil, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { updateProjectStartDateAction } from '@/server/actions/projects';

const HUMAN_FMT = new Intl.DateTimeFormat('en-CA', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function ProjectStartDateEditor({
  projectId,
  startDate,
}: {
  projectId: string;
  startDate: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(startDate ?? '');
  const [pending, startTransition] = useTransition();

  function save(next: string | null) {
    startTransition(async () => {
      const res = await updateProjectStartDateAction({ id: projectId, start_date: next });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(next ? 'Start date updated' : 'Start date cleared');
      setEditing(false);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          type="date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save(value || null);
            if (e.key === 'Escape') {
              setEditing(false);
              setValue(startDate ?? '');
            }
          }}
          className="h-7 w-auto text-xs"
          disabled={pending}
        />
        <button
          type="button"
          onClick={() => save(value || null)}
          disabled={pending}
          aria-label="Save start date"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Check className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setValue(startDate ?? '');
          }}
          disabled={pending}
          aria-label="Cancel"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </span>
    );
  }

  const label = startDate
    ? HUMAN_FMT.format(new Date(`${startDate}T00:00:00Z`))
    : 'not set — uses today';

  return (
    <span className="group inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span>
        Project start: <span className="font-medium text-foreground">{label}</span>
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label="Edit start date"
        className="rounded p-1 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
      >
        <Pencil className="size-3" />
      </button>
    </span>
  );
}
