'use client';

import { Check, Pencil, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { updateProjectManagementFeeAction } from '@/server/actions/projects';

type Props = {
  projectId: string;
  rate: number;
};

function ratePct(rate: number) {
  return Math.round(rate * 1000) / 10;
}

export function ManagementFeeEditor({ projectId, rate }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(ratePct(rate)));
  const [isPending, startTransition] = useTransition();

  function cancel() {
    setEditing(false);
    setValue(String(ratePct(rate)));
  }

  function save() {
    const pct = Number.parseFloat(value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      toast.error('Enter a percentage between 0 and 100.');
      return;
    }
    const newRate = Math.round(pct * 10) / 1000;
    if (Math.abs(newRate - rate) < 0.0001) {
      cancel();
      return;
    }
    startTransition(async () => {
      const res = await updateProjectManagementFeeAction({ id: projectId, rate: newRate });
      if (res.ok) {
        toast.success('Management fee updated');
        setEditing(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          type="number"
          min={0}
          max={100}
          step={0.1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') cancel();
          }}
          onClick={(e) => e.stopPropagation()}
          autoFocus
          className="h-7 w-20 text-sm"
          disabled={isPending}
          aria-label="Management fee percentage"
        />
        <span className="text-sm">%</span>
        <button
          type="button"
          onClick={save}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Save"
          disabled={isPending}
        >
          <Check className="size-4" />
        </button>
        <button
          type="button"
          onClick={cancel}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Cancel"
          disabled={isPending}
        >
          <X className="size-4" />
        </button>
      </span>
    );
  }

  return (
    <span className="group inline-flex items-center gap-1">
      <span className="text-sm font-medium">{ratePct(rate)}%</span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
        aria-label="Edit management fee"
      >
        <Pencil className="size-3.5" />
      </button>
    </span>
  );
}
