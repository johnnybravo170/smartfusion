'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  SubQuoteForm,
  type SubQuoteInitialValues,
} from '@/components/features/projects/sub-quote-form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createClient } from '@/lib/supabase/client';
import {
  reclassifyInboundEmailAction,
  rejectInboundEmailAction,
} from '@/server/actions/inbound-email';
import { StagedBillConfirmDialog, type StagedBillExtracted } from './staged-bill-confirm-dialog';

export type InboundEmailRow = {
  id: string;
  from_address: string;
  from_name: string | null;
  subject: string | null;
  received_at: string;
  classification: string;
  confidence: number | null;
  extracted: Record<string, unknown> | null;
  classifier_notes: string | null;
  project_id: string | null;
  project_match_confidence: number | null;
  status: string;
  error_message: string | null;
  attachment_names: string[];
};

export type ProjectOption = { id: string; name: string };

type SubQuoteCategory = { id: string; name: string; section: 'interior' | 'exterior' | 'general' };

const STATUS_COLOURS: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground',
  processing: 'bg-blue-100 text-blue-700',
  auto_applied: 'bg-emerald-100 text-emerald-700',
  needs_review: 'bg-amber-100 text-amber-700',
  applied: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-muted text-muted-foreground line-through',
  error: 'bg-destructive/10 text-destructive',
  bounced: 'bg-muted text-muted-foreground line-through',
};

export function InboundEmailCard({
  email,
  projects,
}: {
  email: InboundEmailRow;
  projects: ProjectOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedProject, setSelectedProject] = useState(email.project_id ?? '');

  // Bill dialog state
  const [billDialogOpen, setBillDialogOpen] = useState(false);

  // Sub-quote dialog state — categories load on demand because the inbox
  // page doesn't ship them per-project.
  const [subQuoteDialogOpen, setSubQuoteDialogOpen] = useState(false);
  const [subQuoteProjectId, setSubQuoteProjectId] = useState<string | null>(null);
  const [subQuoteCategories, setSubQuoteCategories] = useState<SubQuoteCategory[]>([]);
  const [loadingSubQuoteSetup, setLoadingSubQuoteSetup] = useState(false);

  const canApply = email.classification === 'sub_quote' || email.classification === 'vendor_bill';
  const isTerminal = email.status === 'applied' || email.status === 'auto_applied';
  const needsReview = email.status === 'needs_review';

  async function loadCategoriesAndOpenSubQuote(projectId: string) {
    setLoadingSubQuoteSetup(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('project_budget_categories')
        .select('id, name, section')
        .eq('project_id', projectId)
        .order('display_order');
      if (error) throw new Error(error.message);
      setSubQuoteCategories((data as SubQuoteCategory[]) ?? []);
      setSubQuoteProjectId(projectId);
      setSubQuoteDialogOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load project categories.');
    } finally {
      setLoadingSubQuoteSetup(false);
    }
  }

  function handleConfirm() {
    const projectId = selectedProject || email.project_id;
    if (!projectId) {
      toast.error('Pick a project first.');
      return;
    }
    if (email.classification === 'vendor_bill') {
      setBillDialogOpen(true);
      return;
    }
    if (email.classification === 'sub_quote') {
      void loadCategoriesAndOpenSubQuote(projectId);
      return;
    }
  }

  function handleReject() {
    startTransition(async () => {
      const res = await rejectInboundEmailAction(email.id);
      if (res.ok) {
        toast.success('Dismissed.');
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function handleReclassify() {
    startTransition(async () => {
      const res = await reclassifyInboundEmailAction(email.id);
      if (res.ok) {
        toast.success('Reclassified.');
        router.refresh();
      } else toast.error(res.error);
    });
  }

  const classifyLabel =
    email.classification === 'sub_quote'
      ? 'Vendor Quote'
      : email.classification === 'vendor_bill'
        ? 'Vendor Bill'
        : email.classification === 'other'
          ? 'Other'
          : 'Unclassified';

  const extracted = email.extracted;
  const extractedTotal =
    extracted && typeof extracted === 'object'
      ? ('total_cents' in extracted
          ? Number((extracted as { total_cents: number }).total_cents)
          : null) ||
        ('amount_cents' in extracted
          ? Number((extracted as { amount_cents: number }).amount_cents)
          : null)
      : null;
  const vendor =
    extracted && typeof extracted === 'object' && 'vendor' in extracted
      ? String((extracted as { vendor: string }).vendor)
      : null;

  const subQuoteInitialValues: SubQuoteInitialValues | null =
    email.classification === 'sub_quote' && extracted && typeof extracted === 'object'
      ? {
          vendor_name: (extracted as { vendor?: string }).vendor ?? '',
          total_cents: (extracted as { total_cents?: number }).total_cents ?? null,
          scope_description: (extracted as { notes?: string }).notes ?? '',
          quote_date: (extracted as { quote_date?: string }).quote_date ?? '',
        }
      : null;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOURS[email.status] ?? 'bg-muted'}`}
            >
              {email.status.replace('_', ' ')}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{classifyLabel}</span>
            {email.confidence !== null && (
              <span className="text-xs text-muted-foreground">
                classifier {(Number(email.confidence) * 100).toFixed(0)}%
              </span>
            )}
            {email.project_match_confidence !== null && (
              <span className="text-xs text-muted-foreground">
                match {(Number(email.project_match_confidence) * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <p className="mt-1 font-medium">{email.subject || '(no subject)'}</p>
          <p className="text-xs text-muted-foreground">
            {email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}
            {' · '}
            {new Date(email.received_at).toLocaleString('en-CA', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
        </div>
        {extractedTotal !== null && (
          <div className="text-right">
            <p className="text-xs text-muted-foreground">{vendor}</p>
            <p className="text-lg font-semibold">{formatCurrency(extractedTotal)}</p>
          </div>
        )}
      </div>

      {/* Classifier notes */}
      {email.classifier_notes && (
        <p className="text-xs text-muted-foreground italic">{email.classifier_notes}</p>
      )}

      {email.attachment_names.length > 0 && (
        <p className="text-xs text-muted-foreground">📎 {email.attachment_names.join(', ')}</p>
      )}

      {email.error_message && <p className="text-xs text-destructive">{email.error_message}</p>}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <select
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
          disabled={pending}
        >
          <option value="">— pick project —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {needsReview && canApply && (
          <Button size="sm" onClick={handleConfirm} disabled={pending || loadingSubQuoteSetup}>
            {loadingSubQuoteSetup ? 'Loading…' : 'Review & confirm'}
          </Button>
        )}

        <Button size="sm" variant="ghost" onClick={handleReclassify} disabled={pending}>
          Re-classify
        </Button>

        {!isTerminal && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={handleReject}
            disabled={pending}
          >
            Dismiss
          </Button>
        )}
      </div>

      {/* Bill confirm dialog */}
      {email.classification === 'vendor_bill' && (
        <StagedBillConfirmDialog
          open={billDialogOpen}
          onOpenChange={setBillDialogOpen}
          emailId={email.id}
          extracted={extracted as StagedBillExtracted | null}
          projects={projects}
          defaultProjectId={selectedProject || email.project_id}
          onApplied={() => router.refresh()}
        />
      )}

      {/* Sub-quote confirm dialog (re-uses the canonical SubQuoteForm) */}
      {email.classification === 'sub_quote' && subQuoteDialogOpen && subQuoteProjectId && (
        <Dialog
          open={subQuoteDialogOpen}
          onOpenChange={(next) => {
            setSubQuoteDialogOpen(next);
            if (!next) setSubQuoteProjectId(null);
          }}
        >
          <DialogContent className="sm:max-w-2xl lg:max-w-4xl">
            <DialogHeader>
              <DialogTitle>Confirm vendor quote</DialogTitle>
              <DialogDescription>
                Henry pre-filled this from the forwarded email. Adjust anything that looks off, then
                save.
              </DialogDescription>
            </DialogHeader>
            <SubQuoteForm
              projectId={subQuoteProjectId}
              categories={subQuoteCategories}
              initialValues={subQuoteInitialValues ?? undefined}
              linkToInboundEmail={{ emailId: email.id }}
              onDone={() => {
                setSubQuoteDialogOpen(false);
                setSubQuoteProjectId(null);
                router.refresh();
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
