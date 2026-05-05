'use client';

/**
 * Slim AI-accelerator surface for the new-project page. Drop a quote
 * PDF, photo, or voice memo (or paste a text blob), click parse, and
 * the form fields below pre-fill from the AI extraction.
 *
 * Single-shot: no multi-step state machine, no draft retry UI, no
 * scope-review screen — those live in the deeper LeadIntakeForm
 * (still reachable via /projects/new?intake=full when an inbound lead
 * needs the full guided experience). This component is just the
 * "drop something to skip the typing" optimisation.
 */

import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { useId, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { IntakeDropzone } from '@/components/features/contacts/intake-dropzone';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ParsedIntake } from '@/lib/ai/intake-prompt';
import { uploadIntakeFiles } from '@/lib/storage/intake-uploads';
import { createClient as createBrowserSupabase } from '@/lib/supabase/client';
import { parseInboundLeadAction } from '@/server/actions/intake';

export function IntakeAccelerator({
  onParsed,
  defaultOpen = false,
}: {
  /** Called when the AI parse succeeds. Parent decides which fields
   * to surface. */
  onParsed: (parsed: ParsedIntake) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [files, setFiles] = useState<File[]>([]);
  const [pastedText, setPastedText] = useState('');
  const [isParsing, startParsing] = useTransition();
  const pasteId = useId();

  const canParse = files.length > 0 || pastedText.trim().length > 0;

  function handleParse() {
    if (!canParse) {
      toast.error('Drop a file or paste text first.');
      return;
    }
    startParsing(async () => {
      try {
        const fd = new FormData();
        fd.set('customerName', '');
        fd.set('pastedText', pastedText);

        if (files.length > 0) {
          const supabase = createBrowserSupabase();
          const entries = await uploadIntakeFiles(files, supabase);
          for (const e of entries) {
            fd.append('storageEntries', JSON.stringify(e));
          }
        }

        const res = await parseInboundLeadAction(fd);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        onParsed(res.draft);
        toast.success('Filled in from your file. Review and edit below.');
        // Clear local state so the operator can drop another artifact
        // if they want to layer in more context.
        setFiles([]);
        setPastedText('');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Parse failed.');
      }
    });
  }

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/30"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <Sparkles className="size-4 shrink-0 text-amber-500" />
        <span className="font-medium">Got a quote, photos, or a voice memo?</span>
        <span className="text-muted-foreground">Drop it in to pre-fill the fields below.</span>
      </button>

      {open ? (
        <div className="space-y-3 border-t px-4 py-4">
          <IntakeDropzone
            files={files}
            onFilesAdded={(added) => setFiles((prev) => [...prev, ...added])}
            onRemove={(idx) => setFiles((prev) => prev.filter((_, i) => i !== idx))}
            accept="image/*,application/pdf,audio/*,.m4a,.mp3,.wav"
            multiple
            hint="Drop a quote PDF, photos, or a voice memo. Files upload, then Henry parses."
            disabled={isParsing}
          />
          <div>
            <label
              htmlFor={pasteId}
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Or paste a message / email / scope blurb
            </label>
            <Textarea
              id={pasteId}
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              rows={3}
              placeholder="Paste an email, text message, or rough description…"
              disabled={isParsing}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Voice memos take ~30–60 seconds to transcribe.
            </p>
            <Button type="button" size="sm" onClick={handleParse} disabled={!canParse || isParsing}>
              {isParsing ? 'Parsing…' : 'Pre-fill from AI'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
