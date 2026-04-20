'use client';

import { useState, useTransition } from 'react';
import { updateProjectAction } from '@/server/actions/projects';
import type { ProjectWithRelations } from '@/lib/db/queries/projects';

export function PercentCompleteEditor({ project }: { project: ProjectWithRelations }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(project.percent_complete ?? 0);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      await updateProjectAction({
        id: project.id,
        customer_id: project.customer?.id ?? '',
        name: project.name,
        description: project.description ?? undefined,
        start_date: project.start_date ?? undefined,
        target_end_date: project.target_end_date ?? undefined,
        management_fee_rate: project.management_fee_rate,
        status: project.status,
        phase: project.phase ?? undefined,
        percent_complete: value,
      });
      setEditing(false);
    });
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <span>{project.percent_complete ?? 0}% complete</span>
        {project.phase ? <span>· {project.phase}</span> : null}
        <span className="opacity-0 group-hover:opacity-100 text-xs ml-1">(edit)</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        className="w-32"
      />
      <span className="text-sm font-medium w-10">{value}%</span>
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="text-xs text-primary hover:underline disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={() => { setValue(project.percent_complete ?? 0); setEditing(false); }} className="text-xs text-muted-foreground hover:underline">
        Cancel
      </button>
    </div>
  );
}
