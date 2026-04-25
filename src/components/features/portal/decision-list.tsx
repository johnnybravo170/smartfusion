'use client';

/**
 * Operator-side list of decisions on a project. Shows pending,
 * answered, and dismissed in three sections; provides a Dismiss
 * action on pending rows. The homeowner-facing rendering lives in
 * the public portal page.
 */

import { Loader2, X } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ProjectDecision } from '@/lib/db/queries/project-decisions';
import { cn } from '@/lib/utils';
import { dismissDecisionAction } from '@/server/actions/project-decisions';

export function DecisionList({
  decisions,
  projectId,
}: {
  decisions: ProjectDecision[];
  projectId: string;
}) {
  if (decisions.length === 0) {
    return <p className="text-sm text-muted-foreground">No decision requests yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {decisions.map((d) => (
        <DecisionRow key={d.id} decision={d} projectId={projectId} />
      ))}
    </ul>
  );
}

function DecisionRow({ decision, projectId }: { decision: ProjectDecision; projectId: string }) {
  const [pending, startTransition] = useTransition();

  function onDismiss() {
    startTransition(async () => {
      const res = await dismissDecisionAction(decision.id, projectId);
      if (!res.ok) toast.error(res.error);
    });
  }

  const isPending = decision.status === 'pending';

  return (
    <li
      className={cn(
        'flex items-start justify-between gap-3 rounded-md border p-3',
        decision.status === 'decided' && 'border-emerald-200 bg-emerald-50/40',
        decision.status === 'dismissed' && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{decision.label}</p>
        {decision.description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{decision.description}</p>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {decision.due_date ? (
            <span>Due {new Date(decision.due_date).toLocaleDateString('en-CA')}</span>
          ) : null}
          {decision.status === 'decided' ? (
            <span>
              {decision.decided_value === 'approved'
                ? 'Approved'
                : decision.decided_value === 'declined'
                  ? 'Declined'
                  : `Picked: ${decision.decided_value}`}{' '}
              by {decision.decided_by_customer ?? 'customer'}
            </span>
          ) : null}
          {decision.status === 'dismissed' ? <span>Dismissed</span> : null}
        </div>
      </div>
      {isPending ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          disabled={pending}
          aria-label="Dismiss decision"
          title="Dismiss"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
        </Button>
      ) : null}
    </li>
  );
}
