'use client';

/**
 * Operator-side "Promote to selection" affordance on a customer idea
 * card. Opens the SelectionFormDialog pre-filled from the idea, then
 * stamps the idea row as promoted on success.
 *
 * The original idea-board row stays intact (operators never delete
 * customer content). Re-promoting an already-promoted idea is blocked
 * at the UI layer; the action itself is idempotent for safety.
 */

import { ArrowRight, Loader2 } from 'lucide-react';
import { useState } from 'react';
import {
  SelectionFormDialog,
  type SelectionFormInitialValues,
} from '@/components/features/portal/selection-form-dialog';
import { Button } from '@/components/ui/button';
import type { SelectionCategory } from '@/lib/validators/project-selection';
import {
  type IdeaBoardItem,
  markIdeaBoardItemPromotedAction,
} from '@/server/actions/project-idea-board';

export function PromoteIdeaButton({ projectId, item }: { projectId: string; item: IdeaBoardItem }) {
  const [open, setOpen] = useState(false);

  // Build pre-fill from the idea. Notes get a footer line pointing back
  // at the source URL so the operator can re-find the original later.
  const noteLines: string[] = [];
  if (item.notes) noteLines.push(item.notes);
  if (item.kind === 'link' && item.source_url) {
    noteLines.push(`From customer idea board: ${item.source_url}`);
  }
  const prefilledNotes = noteLines.join('\n\n');

  const initialValues: SelectionFormInitialValues = {
    room: item.room ?? undefined,
    name: item.title ?? undefined,
    notes: prefilledNotes || undefined,
    // Category defaulted to 'paint' inside the dialog; idea content is
    // rarely structured enough to auto-pick, and a wrong default
    // frustrates more than an empty one (see plan §Architecture).
    category: 'paint' as SelectionCategory,
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-7 text-[11px]"
      >
        <ArrowRight className="size-3" aria-hidden />
        Promote
      </Button>
      <SelectionFormDialog
        projectId={projectId}
        open={open}
        onOpenChange={setOpen}
        initialValues={initialValues}
        title="Promote to selection"
        description="Pre-filled from the customer's idea. Edit anything, then add."
        onAfterCreate={async (selectionId) => {
          await markIdeaBoardItemPromotedAction({ itemId: item.id, selectionId });
        }}
      />
    </>
  );
}

export function PromotedBadge({ pending = false }: { pending?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
      {pending ? <Loader2 className="size-2.5 animate-spin" aria-hidden /> : null}
      Promoted
    </span>
  );
}
