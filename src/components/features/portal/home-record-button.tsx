'use client';

/**
 * Operator-side Home Record controls. Shown on the Documents tab.
 *
 * Three states:
 *   1. No record yet → "Generate Home Record" (snapshot only).
 *   2. Record exists → View + Regenerate snapshot + Generate PDF.
 *   3. Record + PDF exist → View + Regenerate + Download PDF + Re-render PDF.
 *
 * Regenerating the snapshot nulls the pdf_path server-side so the PDF
 * controls flip back to "Generate PDF" until the operator builds a
 * fresh one.
 */

import { Download, ExternalLink, FileText, Loader2, RotateCw, Sparkles } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  generateHomeRecordAction,
  generateHomeRecordPdfAction,
} from '@/server/actions/home-records';

type Props = {
  projectId: string;
  existingSlug: string | null;
  hasPdf: boolean;
};

export function HomeRecordButton({ projectId, existingSlug, hasPdf }: Props) {
  const [pending, startTransition] = useTransition();
  const [pdfPending, startPdfTransition] = useTransition();

  function generate() {
    startTransition(async () => {
      const res = await generateHomeRecordAction(projectId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(existingSlug ? 'Home Record refreshed.' : 'Home Record generated.');
    });
  }

  function buildPdf() {
    startPdfTransition(async () => {
      const res = await generateHomeRecordPdfAction(projectId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('PDF ready.');
      if (res.signedUrl) {
        window.open(res.signedUrl, '_blank', 'noopener');
      }
    });
  }

  if (!existingSlug) {
    return (
      <Button type="button" onClick={generate} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
        Generate Home Record
      </Button>
    );
  }

  const viewUrl = `/home-record/${existingSlug}`;
  const downloadUrl = `/home-record/${existingSlug}/download`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="default" size="sm">
        <a href={viewUrl} target="_blank" rel="noreferrer">
          <ExternalLink className="size-4" />
          View
        </a>
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={generate} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
        Regenerate
      </Button>
      {hasPdf ? (
        <>
          <Button asChild variant="outline" size="sm">
            <a href={downloadUrl} target="_blank" rel="noreferrer">
              <Download className="size-4" />
              Download PDF
            </a>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={buildPdf}
            disabled={pdfPending}
            title="Rebuild the PDF with the latest snapshot"
          >
            {pdfPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileText className="size-4" />
            )}
            Rebuild PDF
          </Button>
        </>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={buildPdf} disabled={pdfPending}>
          {pdfPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FileText className="size-4" />
          )}
          Generate PDF
        </Button>
      )}
    </div>
  );
}
