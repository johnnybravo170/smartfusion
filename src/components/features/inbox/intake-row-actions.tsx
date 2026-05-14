'use client';

/**
 * State-aware action menu for one row in the universal /inbox/intake list.
 *
 * Branches per disposition:
 *   - pending_review → Apply (primary intent dialog) + Pick different intent + Dismiss
 *   - applied → View destination + Edit + Move + Undo
 *   - dismissed → Restore
 *   - error → Reclassify (re-runs parser)
 *
 * The actual per-intent dialog is picked from the row's primary_kind. The
 * operator can override with the dropdown's "Pick different intent" submenu.
 * Photos / docs / messages need the primary_artifact_path (path inside the
 * intake-audio bucket) so the action can copy the file into its destination.
 */

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { InboxIntakeRow } from '@/lib/db/queries/intake-drafts';
import {
  dismissIntakeAction,
  moveAppliedIntakeAction,
  restoreDismissedIntakeAction,
  undoIntakeApplyAction,
} from '@/server/actions/inbox-intake';
import { parseIntakeDraftAction } from '@/server/actions/intake';
import { StagedBillConfirmDialog } from './staged-bill-confirm-dialog';
import { StagedDocumentDialog } from './staged-document-dialog';
import { StagedMessageDialog } from './staged-message-dialog';
import { StagedPhotoDialog } from './staged-photo-dialog';

export type ProjectOption = { id: string; name: string };

/** Apply intents the menu can route to. Subset of IntakeIntent that has a
 * dialog (sub_quote opens SubQuoteForm on the project page; new_lead
 * redirects; 'other' falls through to manual pick). */
type DialogIntent = 'vendor_bill' | 'document' | 'photo' | 'message';

const INTENT_LABEL: Record<DialogIntent | 'sub_quote' | 'new_lead', string> = {
  vendor_bill: 'Vendor bill',
  document: 'Project document',
  photo: 'Project photo',
  message: 'Customer message',
  sub_quote: 'Vendor quote',
  new_lead: 'New lead',
};

function pickDefaultIntent(row: InboxIntakeRow): DialogIntent | 'sub_quote' | 'new_lead' | null {
  switch (row.primary_kind) {
    case 'receipt':
      return 'vendor_bill';
    case 'sub_quote_pdf':
      return 'sub_quote';
    case 'spec_drawing_pdf':
      return 'document';
    case 'damage_photo':
    case 'reference_photo':
    case 'inspiration_photo':
    case 'sketch':
    case 'screenshot':
      return 'photo';
    case 'customer_message':
      return 'message';
    case 'voice_memo':
    case 'text_body':
    case 'other':
      return null;
    default:
      return null;
  }
}

export function IntakeRowActions({
  row,
  projects,
}: {
  row: InboxIntakeRow;
  projects: ProjectOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Dialog state — only one open at a time per row.
  const [openDialog, setOpenDialog] = useState<DialogIntent | null>(null);
  // Move-to-project mini state (uses a small inline picker rather than a
  // dialog — keeps the surface tight; reachable from the applied menu).
  const [showMovePicker, setShowMovePicker] = useState(false);

  const refresh = () => router.refresh();

  function applyDialog(intent: DialogIntent | 'sub_quote' | 'new_lead' | null) {
    if (!intent) {
      toast.message('No default intent for this kind — pick one below.');
      return;
    }
    if (intent === 'sub_quote') {
      // Vendor quotes go through the canonical SubQuoteForm on the project
      // page (it owns allocations + balance UX). Redirect with a draftId
      // hint so SubQuoteForm can stamp the draft applied after save.
      if (!row.accepted_project_id) {
        toast.message('Open this draft on a project page to create a vendor quote.');
        return;
      }
      router.push(`/projects/${row.accepted_project_id}?subQuoteDraftId=${row.id}`);
      return;
    }
    if (intent === 'new_lead') {
      router.push(`/projects/new?intake=full&draft=${row.id}`);
      return;
    }
    setOpenDialog(intent);
  }

  function handleDismiss() {
    if (!window.confirm('Dismiss this intake item?')) return;
    startTransition(async () => {
      const res = await dismissIntakeAction(row.id);
      if (res.ok) {
        toast.success('Dismissed.');
        refresh();
      } else toast.error(res.error);
    });
  }

  function handleRestore() {
    startTransition(async () => {
      const res = await restoreDismissedIntakeAction(row.id);
      if (res.ok) {
        toast.success('Restored.');
        refresh();
      } else toast.error(res.error);
    });
  }

  function handleUndo() {
    if (
      !window.confirm(
        'Undo this apply? The destination row will be deleted. (Sub-quotes are unlinked but kept.)',
      )
    )
      return;
    startTransition(async () => {
      const res = await undoIntakeApplyAction(row.id);
      if (res.ok) {
        toast.success('Undone — back to pending review.');
        refresh();
      } else toast.error(res.error);
    });
  }

  function handleMoveTo(newProjectId: string) {
    if (!newProjectId || newProjectId === row.accepted_project_id) {
      setShowMovePicker(false);
      return;
    }
    startTransition(async () => {
      const res = await moveAppliedIntakeAction({ draftId: row.id, newProjectId });
      if (res.ok) {
        toast.success('Moved.');
        setShowMovePicker(false);
        refresh();
      } else toast.error(res.error);
    });
  }

  function handleReclassify() {
    startTransition(async () => {
      const res = await parseIntakeDraftAction(row.id);
      if (res.ok) {
        toast.success('Reclassified.');
        refresh();
      } else toast.error(res.error);
    });
  }

  const defaultIntent = pickDefaultIntent(row);

  // Default project: any recognized customer's first active project? No —
  // V2 keeps it simple: accepted_project_id (if previously stamped) or null.
  const defaultProjectId = row.accepted_project_id ?? null;

  // Artifact prop for dialogs that need to copy from the intake bucket.
  const artifact =
    row.primary_artifact_path && row.primary_artifact_mime
      ? {
          path: row.primary_artifact_path,
          mime: row.primary_artifact_mime,
          bytes: row.primary_artifact_bytes ?? undefined,
        }
      : null;

  return (
    <div className="flex items-center gap-2">
      {row.disposition === 'pending_review' && (
        <>
          {defaultIntent && (
            <Button size="sm" onClick={() => applyDialog(defaultIntent)} disabled={pending}>
              Apply as {INTENT_LABEL[defaultIntent]}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={pending}>
                {defaultIntent ? <ChevronDown className="size-4" /> : 'Apply'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Apply as…</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => applyDialog('vendor_bill')}>
                Vendor bill
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => applyDialog('sub_quote')}>
                Vendor quote
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => applyDialog('document')}>
                Project document
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => applyDialog('photo')}>
                Project photo
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => applyDialog('message')}>
                Customer message
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => applyDialog('new_lead')}>New lead</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleDismiss} className="text-destructive">
                Dismiss
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {row.disposition === 'applied' && (
        <>
          {row.accepted_project_id && (
            <Link
              href={`/projects/${row.accepted_project_id}`}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              View project
            </Link>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={pending}>
                Actions <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Move to project…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-60 overflow-y-auto">
                  {projects.map((p) => (
                    <DropdownMenuItem key={p.id} onSelect={() => handleMoveTo(p.id)}>
                      {p.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={handleUndo} className="text-destructive">
                Undo apply
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {row.disposition === 'dismissed' && (
        <Button size="sm" variant="ghost" onClick={handleRestore} disabled={pending}>
          Restore
        </Button>
      )}

      {row.disposition === 'error' && (
        <Button size="sm" variant="ghost" onClick={handleReclassify} disabled={pending}>
          Reclassify
        </Button>
      )}

      {/* Hidden helper to render the inline "Move to" picker when triggered.
          We use the DropdownMenuSub above instead, so this is unused — kept
          as a stub in case future needs reach for a richer combobox. */}
      {showMovePicker && (
        <Select onValueChange={handleMoveTo} disabled={pending}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder="Pick new project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Per-intent dialogs */}
      {openDialog === 'vendor_bill' && (
        <StagedBillConfirmDialog
          open
          onOpenChange={(next) => !next && setOpenDialog(null)}
          draftId={row.id}
          extracted={null}
          projects={projects}
          defaultProjectId={defaultProjectId}
          onApplied={refresh}
        />
      )}

      {openDialog === 'document' && artifact && (
        <StagedDocumentDialog
          open
          onOpenChange={(next) => !next && setOpenDialog(null)}
          draftId={row.id}
          artifact={artifact}
          projects={projects}
          defaultProjectId={defaultProjectId}
          defaultTitle={row.email_subject ?? undefined}
          onApplied={refresh}
        />
      )}

      {openDialog === 'photo' && artifact && (
        <StagedPhotoDialog
          open
          onOpenChange={(next) => !next && setOpenDialog(null)}
          draftId={row.id}
          artifact={artifact}
          projects={projects}
          defaultProjectId={defaultProjectId}
          defaultCaption={row.email_subject ?? undefined}
          onApplied={refresh}
        />
      )}

      {openDialog === 'message' && (
        <StagedMessageDialog
          open
          onOpenChange={(next) => !next && setOpenDialog(null)}
          draftId={row.id}
          projects={projects}
          defaultProjectId={defaultProjectId}
          defaultSubject={row.email_subject ?? undefined}
          onApplied={refresh}
        />
      )}
    </div>
  );
}
