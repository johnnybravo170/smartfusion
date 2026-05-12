'use client';

/**
 * "Upload vendor quote" flow: operator picks a PDF or image → we call the
 * AI parser → surface results + any AI warnings → hand off to
 * SubQuoteForm pre-filled with extracted data and matched category
 * allocations. The same File is passed through as the attachment so we
 * don't re-upload.
 *
 * Unmatched AI allocations (category names the model invented that don't
 * exist on the project) are surfaced in the form's Notes so the operator
 * can read the AI's reasoning and decide whether to create that category
 * or reallocate to an existing one.
 */

import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { parseSubQuoteFromFileAction } from '@/server/actions/sub-quotes';
import { SubQuoteForm, type SubQuoteInitialValues } from './sub-quote-form';

type Category = { id: string; name: string; section: 'interior' | 'exterior' | 'general' };

export function SubQuoteUploadButton({
  projectId,
  categories,
}: {
  projectId: string;
  categories: Category[];
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [warning, setWarning] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [initialValues, setInitialValues] = useState<SubQuoteInitialValues | null>(null);

  function handlePick() {
    setWarning(null);
    fileRef.current?.click();
  }

  function handleFile(file: File) {
    startTransition(async () => {
      const fd = new FormData();
      fd.set('project_id', projectId);
      fd.set('file', file);
      const result = await parseSubQuoteFromFileAction(fd);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      if (result.docType === 'not_sub_quote') {
        // Open the form anyway with the original file attached, but warn
        // the operator so they can double-check.
        setWarning(
          result.reasonIfNot ??
            "This doesn't look like a vendor quote. Review the details carefully before saving.",
        );
      }

      // Weave any AI-unmatched allocations into the form notes so the
      // operator sees the reasoning and can act on it.
      const unmatchedNote = result.unmatchedAllocations.length
        ? `AI suggested but no matching category:\n${result.unmatchedAllocations
            .map(
              (u) =>
                `  • ${u.proposedCategoryName} — $${(u.allocatedCents / 100).toFixed(2)} (${u.reasoning})`,
            )
            .join('\n')}`
        : '';

      setInitialValues({
        vendor_name: result.extracted.vendor_name ?? '',
        vendor_email: result.extracted.vendor_email ?? '',
        vendor_phone: result.extracted.vendor_phone ?? '',
        total_cents: result.extracted.total_cents ?? null,
        scope_description: result.extracted.scope_description ?? '',
        quote_date: result.extracted.quote_date ?? '',
        valid_until: result.extracted.valid_until ?? '',
        allocations: result.allocations.map((a) => ({
          budget_category_id: a.categoryId,
          allocated_cents: a.allocatedCents,
          notes: a.reasoning,
        })),
        attachment: file,
        notes: unmatchedNote,
      });
      setOpen(true);
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={handlePick}
        disabled={pending || categories.length === 0}
        title={categories.length === 0 ? 'Create at least one budget category first.' : undefined}
      >
        {pending ? (
          <Loader2 className="mr-1 size-3.5 animate-spin" />
        ) : (
          <Sparkles className="mr-1 size-3.5" />
        )}
        {pending ? 'Reading…' : 'Upload quote'}
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.size > 10 * 1024 * 1024) {
            toast.error('File is larger than 10MB.');
            return;
          }
          handleFile(f);
        }}
      />

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(false);
            setInitialValues(null);
            setWarning(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl lg:max-w-4xl xl:max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4" /> Review vendor quote
            </DialogTitle>
            <DialogDescription>
              Henry read the document and filled in what he could. Adjust anything that looks off,
              then save.
            </DialogDescription>
          </DialogHeader>
          {warning ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 flex-shrink-0" />
              <div>
                <p className="font-medium">This might not be a vendor quote.</p>
                <p>{warning}</p>
              </div>
            </div>
          ) : null}
          {initialValues ? (
            <SubQuoteForm
              projectId={projectId}
              categories={categories}
              initialValues={initialValues}
              onDone={() => {
                setOpen(false);
                setInitialValues(null);
                setWarning(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
