'use client';

/**
 * Defense-in-depth notice on the operator's invoice detail page when
 * the tenant has no GST/HST number on file. Should be impossible after
 * the first-send gate, but if a draft was created before the gate
 * shipped — or if the field gets cleared — this surfaces it before the
 * operator hits Send.
 */

import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GstNumberPromptDialog } from '@/components/features/shared/gst-number-prompt-dialog';
import { Button } from '@/components/ui/button';

export function MissingGstNotice() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <section className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
      <div className="flex flex-1 flex-col gap-2 text-sm text-amber-900 dark:text-amber-100">
        <div>
          <p className="font-medium">No GST/HST number on file</p>
          <p className="text-amber-800/90 dark:text-amber-200/90">
            CRA requires your GST/HST number on every invoice. Add it before sending — we'll block
            the send otherwise.
          </p>
        </div>
        <div>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Add GST/HST number
          </Button>
        </div>
      </div>
      <GstNumberPromptDialog
        open={open}
        onOpenChange={setOpen}
        kind="invoice"
        onSaved={() => router.refresh()}
      />
    </section>
  );
}
