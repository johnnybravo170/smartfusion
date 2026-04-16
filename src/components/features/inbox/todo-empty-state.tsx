import { Inbox } from 'lucide-react';

export function TodoEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card p-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Inbox className="size-5 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Nothing on your list right now.</p>
        <p className="text-xs text-muted-foreground">
          Great job. Add one above when something pops up.
        </p>
      </div>
    </div>
  );
}
