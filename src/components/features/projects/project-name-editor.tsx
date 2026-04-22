'use client';

import { Check, Pencil, X } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { renameProjectAction } from '@/server/actions/projects';

type Props = {
  projectId: string;
  name: string;
  variant?: 'heading' | 'inline';
};

export function ProjectNameEditor({ projectId, name, variant = 'heading' }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [isPending, startTransition] = useTransition();

  function save() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) {
      setEditing(false);
      setValue(name);
      return;
    }
    startTransition(async () => {
      const res = await renameProjectAction({ id: projectId, name: trimmed });
      if (res.ok) {
        toast.success('Project renamed');
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
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') {
              setEditing(false);
              setValue(name);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          autoFocus
          className={cn(
            variant === 'heading' ? 'h-9 text-2xl font-semibold' : 'h-7 text-sm',
            'w-auto min-w-[200px]',
          )}
          disabled={isPending}
        />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            save();
          }}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Save"
          disabled={isPending}
        >
          <Check className="size-4" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(false);
            setValue(name);
          }}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Cancel"
          disabled={isPending}
        >
          <X className="size-4" />
        </button>
      </span>
    );
  }

  if (variant === 'heading') {
    return (
      <span className="group inline-flex items-center gap-2">
        <Link href={`/projects/${projectId}`} className="hover:underline">
          <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
        </Link>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
          aria-label="Rename project"
        >
          <Pencil className="size-3.5" />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setEditing(true);
      }}
      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
      aria-label="Rename project"
    >
      <Pencil className="size-3.5" />
    </button>
  );
}
