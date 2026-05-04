'use client';

/**
 * Inbound lead intake — operator drops screenshots + photos + voice
 * memos + an optional pasted message, Henry returns a draft estimate,
 * operator tweaks and accepts. Four phases live in one component:
 *
 *   phase = 'upload'      → form for fresh intakes
 *   phase = 'processing'  → spinner + plain-English status while
 *                            Whisper / Opus are running. Polling the
 *                            persisted intake_drafts row every 4 s.
 *   phase = 'review'      → editable draft + Accept
 *   phase = 'failed'      → error + retry button (Stage B retry uses
 *                            the persisted transcript; no re-Whisper)
 *
 * The form accepts an optional `initialDraft` prop. When the page is
 * loaded with `?draft=<id>`, the server-side loader fills it and the
 * form picks up where the previous run left off — refresh-safe,
 * shareable URL, recoverable from a parse failure without re-uploading.
 */

import {
  Camera,
  FileQuestion,
  FileText,
  Image as ImageIcon,
  Lightbulb,
  Loader2,
  MessageSquare,
  Mic,
  Pencil,
  Plus,
  Receipt,
  RefreshCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ExistingMatchesBanner } from '@/components/features/contacts/existing-matches-banner';
import { IntakeDropzone } from '@/components/features/contacts/intake-dropzone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ParsedIntake } from '@/lib/ai/intake-prompt';
import type { ContactMatch } from '@/lib/db/queries/contact-matches-types';
import type { IntakeDraftRow } from '@/lib/db/queries/intake-drafts';
import { resizeImage } from '@/lib/storage/resize-image';
import { createClient as createBrowserSupabase } from '@/lib/supabase/client';
import {
  acceptInboundLeadAction,
  type IntakeArtifact,
  type IntakeArtifactKind,
  type IntakeAugmentation,
  type ParseModelChoice,
  parseInboundLeadAction,
  parseIntakeDraftAction,
} from '@/server/actions/intake';

type Phase = 'upload' | 'processing' | 'review' | 'failed';

function stampDraft(d: ParsedIntake): ParsedIntake {
  return {
    ...d,
    categories: d.categories.map((b) => ({
      ...b,
      _k: crypto.randomUUID(),
      lines: b.lines.map((l) => ({ ...l, _k: crypto.randomUUID() })),
    })) as ParsedIntake['categories'],
  };
}

function statusToPhase(status: IntakeDraftRow['status']): Phase {
  if (status === 'ready') return 'review';
  if (status === 'failed') return 'failed';
  return 'processing';
}

function processingMessage(status: IntakeDraftRow['status']): string {
  if (status === 'transcribing') return 'Listening to your walkthrough…';
  if (status === 'extracting') return "Henry's making sense of it…";
  if (status === 'rethinking') return "Henry's having another think…";
  return 'Working…';
}

const ARTIFACT_KIND_META: Record<
  IntakeArtifactKind,
  { Icon: React.ComponentType<{ className?: string }>; label: string }
> = {
  voice_memo: { Icon: Mic, label: 'Voice memo' },
  damage_photo: { Icon: Camera, label: 'Damage photo' },
  reference_photo: { Icon: ImageIcon, label: 'Reference photo' },
  sketch: { Icon: Pencil, label: 'Sketch' },
  screenshot: { Icon: MessageSquare, label: 'Screenshot' },
  sub_quote_pdf: { Icon: FileText, label: 'Sub-trade quote' },
  spec_drawing_pdf: { Icon: FileText, label: 'Spec drawing' },
  receipt: { Icon: Receipt, label: 'Receipt' },
  inspiration_photo: { Icon: Sparkles, label: 'Inspiration' },
  other: { Icon: FileQuestion, label: 'Artifact' },
};

const CONFIDENCE_TONE: Record<IntakeAugmentation['confidence'], string> = {
  high: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-200',
  medium:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200',
  low: 'border-muted-foreground/30 bg-muted text-muted-foreground',
};

function SuggestionsBlock({
  suggestions,
  onAccept,
  onDismiss,
}: {
  suggestions: IntakeAugmentation[];
  onAccept: (s: IntakeAugmentation) => void;
  onDismiss: (s: IntakeAugmentation) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Lightbulb className="size-4 text-amber-500" />
        <p className="text-sm font-medium">Henry suggests you might be missing:</p>
      </div>
      <ul className="space-y-2">
        {suggestions.map((s) => (
          <li
            key={s.id}
            className="flex flex-col gap-2 rounded-md border bg-background p-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{s.title}</span>
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${CONFIDENCE_TONE[s.confidence]}`}
                >
                  {s.confidence}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  → {s.suggested_section} / {s.suggested_category}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{s.reasoning}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="outline" onClick={() => onAccept(s)}>
                <Plus className="mr-1 size-3" />
                Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDismiss(s)}
                aria-label="Dismiss suggestion"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArtifactChipRow({ artifacts }: { artifacts: IntakeArtifact[] | null }) {
  if (!artifacts || artifacts.length === 0) return null;
  const allClassified = artifacts.every((a) => !!a.kind);
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Henry sees: {artifacts.length} {artifacts.length === 1 ? 'artifact' : 'artifacts'}
        {!allClassified ? (
          <span className="ml-1 inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            still classifying…
          </span>
        ) : null}
      </p>
      <div className="flex flex-wrap gap-2">
        {artifacts.map((a, i) => {
          const meta = a.kind ? ARTIFACT_KIND_META[a.kind] : null;
          const Icon = meta?.Icon ?? FileQuestion;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: artifacts are positionally meaningful (referenced by index in classifications)
              key={`${a.path}-${i}`}
              className="inline-flex max-w-full items-center gap-2 rounded-full border bg-background px-3 py-1.5"
              title={a.label ?? a.name}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-xs font-medium">{meta?.label ?? 'Classifying…'}</span>
              {a.label ? (
                <span className="truncate text-xs text-muted-foreground">— {a.label}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RESIZE_THRESHOLD_BYTES = 2 * 1024 * 1024;

async function shrinkIfNeeded(file: File): Promise<File> {
  if (file.type === 'application/pdf') return file;
  if (!file.type.startsWith('image/')) return file;

  // OpenAI Vision only accepts png, jpeg, gif, webp. HEIC/HEIF from iPhones
  // and anything else non-standard must get converted to JPEG regardless of
  // size, or the vision pass returns a 400 unsupported-image error.
  const OPENAI_FRIENDLY = /^image\/(jpeg|jpg|png|gif|webp)$/i;
  const needsFormatConversion = !OPENAI_FRIENDLY.test(file.type);
  const needsShrink = file.size > RESIZE_THRESHOLD_BYTES;
  if (!needsFormatConversion && !needsShrink) return file;

  try {
    const blob = await resizeImage(file, { maxDimension: 2048, quality: 0.85 });
    const newName = file.name.replace(/\.(heic|heif|png|webp|avif)$/i, '.jpg');
    return new File([blob], newName || 'image.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/**
 * Block the browser's default drag-drop behaviour on the whole window while
 * this form is mounted. Without this, a file dropped anywhere outside the
 * IntakeDropzone (textarea, empty margin, etc.) makes the browser navigate
 * to file://… and shows the "This page couldn't load" chrome error.
 */
function usePreventDefaultWindowDrop() {
  useEffect(() => {
    function prevent(e: DragEvent) {
      e.preventDefault();
    }
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);
}

export function LeadIntakeForm({
  parseModel = 'gpt-4.1',
  initialDraft = null,
}: {
  parseModel?: ParseModelChoice;
  initialDraft?: IntakeDraftRow | null;
} = {}) {
  usePreventDefaultWindowDrop();
  const router = useRouter();

  // Pull the active extraction (envelope shape `{v1,v2,active}`) into the
  // editable draft. Falls back across active → v2 → v1 to stay robust to
  // partially-populated rows.
  const initialExtraction = (() => {
    if (!initialDraft?.ai_extraction) return null;
    const env = initialDraft.ai_extraction;
    return env[env.active] ?? env.v2 ?? env.v1 ?? null;
  })();

  const [phase, setPhase] = useState<Phase>(
    initialDraft ? statusToPhase(initialDraft.status) : 'upload',
  );
  const [draftId, setDraftId] = useState<string | null>(initialDraft?.id ?? null);
  const [draftStatus, setDraftStatus] = useState<IntakeDraftRow['status'] | null>(
    initialDraft?.status ?? null,
  );
  const [customerName, setCustomerName] = useState(initialDraft?.customer_name ?? '');
  const [pastedText, setPastedText] = useState(initialDraft?.pasted_text ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [draft, setDraft] = useState<ParsedIntake | null>(
    initialExtraction ? stampDraft(initialExtraction) : null,
  );
  const [transcript, setTranscript] = useState<string | null>(initialDraft?.transcript ?? null);
  const [parsedBy, setParsedBy] = useState<string | null>(initialDraft?.parsed_by ?? null);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    initialDraft?.error_message ?? null,
  );
  const [duplicates, setDuplicates] = useState<ContactMatch[]>([]);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<Set<string>>(new Set());
  const [isParsing, startParsing] = useTransition();
  const [isAccepting, startAccepting] = useTransition();
  const [isRetrying, startRetrying] = useTransition();

  // Re-sync from the server whenever a fresh initialDraft lands (e.g.
  // polling fired router.refresh() and the page re-rendered with an
  // updated row). Keying on id + status + updated_at means we only
  // re-init on a real change, not every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment
  useEffect(() => {
    if (!initialDraft) return;
    setDraftId(initialDraft.id);
    setDraftStatus(initialDraft.status);
    setPhase(statusToPhase(initialDraft.status));
    setErrorMessage(initialDraft.error_message ?? null);
    setTranscript(initialDraft.transcript ?? null);
    setParsedBy(initialDraft.parsed_by ?? null);
    setCustomerName((prev) => prev || (initialDraft.customer_name ?? ''));
    setPastedText((prev) => prev || (initialDraft.pasted_text ?? ''));
    if (initialDraft.ai_extraction) {
      const env = initialDraft.ai_extraction;
      const next = env[env.active] ?? env.v2 ?? env.v1 ?? null;
      if (next) setDraft(stampDraft(next));
    }
  }, [initialDraft?.id, initialDraft?.status, initialDraft?.updated_at]);

  // Poll the server while the draft is in flight. router.refresh()
  // re-runs the page server component; a status change updates
  // initialDraft → the effect above re-syncs.
  useEffect(() => {
    if (phase !== 'processing') return;
    const id = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(id);
  }, [phase, router]);

  // Auto-fire the parse 1.5s after the operator stops typing / pasting.
  // File drops fire synchronously from handleFilesAdded; the "Read intake"
  // button is the manual backup. runParse is intentionally not a dep — it
  // reads current state via closure and adding it would reset the debounce
  // timer on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (phase !== 'upload') return;
    if (isParsing) return;
    if (files.length > 0) return;
    if (!customerName.trim() && !pastedText.trim()) return;
    const id = setTimeout(() => runParse(), 1500);
    return () => clearTimeout(id);
  }, [customerName, pastedText, phase, isParsing, files.length]);

  function runParse(overrides?: { files?: File[]; customerName?: string; pastedText?: string }) {
    const useFiles = overrides?.files ?? files;
    const useName = overrides?.customerName ?? customerName;
    const useText = overrides?.pastedText ?? pastedText;
    if (!useName.trim() && useFiles.length === 0 && !useText.trim()) {
      toast.error('Add a customer name, image, or pasted text first.');
      return;
    }
    startParsing(async () => {
      const fd = new FormData();
      fd.set('customerName', useName);
      fd.set('pastedText', useText);

      // EVERY file rides via Supabase Storage — not through the server
      // action body. Vercel caps server-action bodies around 4.5 MB,
      // which two phone photos or one voice memo blow right past. The
      // client uploads into the `intake-audio` storage bucket (yes, name now
      // covers images + PDFs too) under its own <tenant>/<uid>/ prefix;
      // the server downloads, processes, and deletes.
      if (useFiles.length > 0) {
        const supabase = createBrowserSupabase();
        const { data: auth } = await supabase.auth.getUser();
        const userId = auth.user?.id;
        if (!userId) {
          toast.error('Please sign in again before dropping files.');
          return;
        }
        for (const raw of useFiles) {
          const prepared = await shrinkIfNeeded(raw);
          const ext = prepared.name.split('.').pop()?.toLowerCase() || 'bin';
          // Path layout matches the storage bucket RLS: foldername[2] = auth.uid().
          const path = `tenant/${userId}/${crypto.randomUUID()}.${ext}`;
          const { error: upErr } = await supabase.storage
            .from('intake-audio')
            .upload(path, prepared, {
              contentType: prepared.type || 'application/octet-stream',
            });
          if (upErr) {
            toast.error(`Upload failed: ${upErr.message}`);
            return;
          }
          // Keep the original filename paired with the storage path so the
          // server can include it in the AI prompt — filenames often carry
          // customer names + addresses ("Tony flooding job. 2452 mountain
          // drive.m4a") that the parser can then pull into structured fields.
          fd.append(
            'storageEntries',
            JSON.stringify({ path, name: prepared.name || raw.name || 'file' }),
          );
        }
      }
      const res = await parseInboundLeadAction(fd, { model: parseModel });
      if (!res.ok) {
        toast.error(res.error);
        // The draft row was created but a later stage failed — navigate
        // to ?draft=<id> so the operator can see the error + retry button
        // and the URL is refresh-safe.
        if (res.draftId) {
          setDraftId(res.draftId);
          setErrorMessage(res.error);
          setPhase('failed');
          router.replace(`/projects/new?draft=${res.draftId}`);
        }
        return;
      }
      setDraftId(res.draftId);
      setDraft(stampDraft(res.draft));
      setTranscript(res.transcript ?? null);
      setParsedBy(res.parsedBy ?? null);
      setErrorMessage(null);
      setPhase('review');
      // Lock the URL to the draft so refresh + back-button keep state.
      router.replace(`/projects/new?draft=${res.draftId}`);
    });
  }

  function handleRetry() {
    if (!draftId) return;
    startRetrying(async () => {
      const res = await parseIntakeDraftAction(draftId, { model: parseModel });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setDraft(stampDraft(res.draft));
      setTranscript(res.transcript ?? null);
      setParsedBy(res.parsedBy ?? null);
      setErrorMessage(null);
      setPhase('review');
    });
  }

  function handleParse(e: React.FormEvent) {
    e.preventDefault();
    runParse();
  }

  function handleFilesAdded(picked: File[]) {
    if (picked.length === 0) return;
    const nextFiles = [...files, ...picked];
    setFiles(nextFiles);
    // Auto-fire parse the moment anything is dropped — no second click.
    runParse({ files: nextFiles });
  }

  /**
   * Add a Henry suggestion as a new line on the editable draft. Lands
   * in the matching category by name (case-insensitive); creates a new
   * category at the right section if none matches.
   */
  function handleAcceptSuggestion(s: IntakeAugmentation) {
    if (!draft) return;
    const targetName = s.suggested_category.trim();
    const targetSection = s.suggested_section;
    const targetLower = targetName.toLowerCase();
    const existingIdx = draft.categories.findIndex(
      (c) => c.name.trim().toLowerCase() === targetLower,
    );
    type Line = ParsedIntake['categories'][number]['lines'][number];
    // Same pattern as the rest of the form: append `_k` at runtime, cast
    // through unknown — `_k` lives on rendered objects but isn't in the
    // ParsedIntake schema (it's a React-keying concern, not data).
    const newLine = {
      label: s.title,
      notes: s.reasoning,
      qty: 1,
      unit: 'lot',
      unit_price_cents: null,
      source_image_indexes: [],
      _k: crypto.randomUUID(),
    } as unknown as Line;
    let nextCategories: ParsedIntake['categories'];
    if (existingIdx >= 0) {
      nextCategories = draft.categories.map((c, i) =>
        i === existingIdx ? { ...c, lines: [...c.lines, newLine] } : c,
      );
    } else {
      const newCategory = {
        name: targetName,
        section: targetSection,
        lines: [newLine],
        _k: crypto.randomUUID(),
      } as unknown as ParsedIntake['categories'][number];
      nextCategories = [...draft.categories, newCategory];
    }
    setDraft({ ...draft, categories: nextCategories });
    setDismissedSuggestionIds((prev) => {
      const next = new Set(prev);
      next.add(s.id);
      return next;
    });
    toast.success(`Added "${s.title}" to ${targetName}`);
  }

  function handleDismissSuggestion(s: IntakeAugmentation) {
    setDismissedSuggestionIds((prev) => {
      const next = new Set(prev);
      next.add(s.id);
      return next;
    });
  }

  function handleAccept(options?: { useExistingContactId?: string; confirmCreate?: boolean }) {
    if (!draft) return;
    startAccepting(async () => {
      const res = await acceptInboundLeadAction(draft, {
        ...options,
        draftId: draftId ?? undefined,
      });
      if (!res.ok) {
        if (res.duplicates && res.duplicates.length > 0) {
          setDuplicates(res.duplicates);
          return;
        }
        toast.error(res.error);
        return;
      }
      toast.success('Project created');
      router.push(`/projects/${res.projectId}?tab=estimate`);
    });
  }

  if (phase === 'processing') {
    return (
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          {processingMessage(draftStatus ?? 'extracting')}
        </p>
        <ArtifactChipRow artifacts={initialDraft?.artifacts ?? null} />
        {transcript ? <TranscriptPanel transcript={transcript} /> : null}
        <p className="text-xs text-muted-foreground">
          This page is safe to leave or refresh — the draft is saved and Henry will keep working.
        </p>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <div>
          <p className="text-sm font-medium">Something went sideways during the parse.</p>
          {errorMessage ? (
            <p className="mt-1 text-sm text-muted-foreground">{errorMessage}</p>
          ) : null}
        </div>
        <ArtifactChipRow artifacts={initialDraft?.artifacts ?? null} />
        {transcript ? (
          <>
            <TranscriptPanel transcript={transcript} />
            <p className="text-xs text-muted-foreground">
              Transcript is saved. Retry the parse below — Henry won't re-listen to the audio, just
              take another swing at extracting work items.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No transcript was captured before the failure. Re-upload the memo to start over.
          </p>
        )}
        <div className="flex items-center gap-2">
          {transcript && draftId ? (
            <Button onClick={handleRetry} disabled={isRetrying}>
              {isRetrying ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Retrying parse…
                </>
              ) : (
                <>
                  <RefreshCcw className="mr-1.5 size-3.5" />
                  Retry parse
                </>
              )}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => {
              setDraftId(null);
              setDraft(null);
              setTranscript(null);
              setParsedBy(null);
              setErrorMessage(null);
              setDraftStatus(null);
              setPhase('upload');
              router.replace('/projects/new');
            }}
          >
            Start over
          </Button>
        </div>
      </div>
    );
  }

  if (phase === 'review' && draft) {
    return (
      <div className="space-y-5">
        {duplicates.length > 0 ? (
          <ExistingMatchesBanner
            matches={duplicates}
            onUseExisting={(id) => {
              setDuplicates([]);
              handleAccept({ useExistingContactId: id });
            }}
            onCreateAnyway={() => {
              setDuplicates([]);
              handleAccept({ confirmCreate: true });
            }}
            useLabel="Use this contact for the new project"
          />
        ) : null}
        <ArtifactChipRow artifacts={initialDraft?.artifacts ?? null} />
        <SuggestionsBlock
          suggestions={(initialDraft?.augmentations ?? []).filter(
            (s) => !dismissedSuggestionIds.has(s.id),
          )}
          onAccept={handleAcceptSuggestion}
          onDismiss={handleDismissSuggestion}
        />
        {transcript ? <TranscriptPanel transcript={transcript} /> : null}
        {parsedBy ? <p className="text-xs text-muted-foreground">Parsed by: {parsedBy}</p> : null}
        <ReviewDraft
          draft={draft}
          onChange={setDraft}
          onBack={() => setPhase('upload')}
          onAccept={() => handleAccept()}
          isAccepting={isAccepting}
        />
      </div>
    );
  }

  return (
    <form onSubmit={handleParse} className="space-y-4 rounded-lg border bg-card p-5">
      <div>
        <label htmlFor="cust-name" className="mb-1 block text-sm font-medium">
          Customer name
        </label>
        <Input
          id="cust-name"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          placeholder="e.g. Lori Smith"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Required eventually — fine to leave blank if Henry can read it from the screenshot.
        </p>
      </div>

      <div>
        <p className="mb-1 block text-sm font-medium">Screenshots, photos, sketches, PDFs</p>
        <IntakeDropzone
          files={files}
          onFilesAdded={handleFilesAdded}
          onRemove={(i) => setFiles((prev) => prev.filter((_, j) => j !== i))}
          accept="image/*,application/pdf,audio/*"
          multiple
          disabled={isParsing}
          inputId="images"
          hint="Drag in a text-thread screenshot, site photo, sketch, sub-trade quote PDF, or a voice memo (m4a / mp3 / wav) — or click to choose."
        />
      </div>

      <div>
        <label htmlFor="pasted" className="mb-1 block text-sm font-medium">
          Or paste the message text
        </label>
        <Textarea
          id="pasted"
          rows={4}
          value={pastedText}
          onChange={(e) => setPastedText(e.target.value)}
          placeholder="Paste here if you'd rather type/paste than screenshot."
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={isParsing}>
          {isParsing ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Reading…
            </>
          ) : (
            'Read intake'
          )}
        </Button>
      </div>
    </form>
  );
}

function ReviewDraft({
  draft,
  onChange,
  onBack,
  onAccept,
  isAccepting,
}: {
  draft: ParsedIntake;
  onChange: (d: ParsedIntake) => void;
  onBack: () => void;
  onAccept: () => void;
  isAccepting: boolean;
}) {
  function copyReply() {
    navigator.clipboard.writeText(draft.reply_draft).then(() => toast.success('Reply copied'));
  }

  function patchCustomer(patch: Partial<ParsedIntake['customer']>) {
    onChange({ ...draft, customer: { ...draft.customer, ...patch } });
  }
  function patchProject(patch: Partial<ParsedIntake['project']>) {
    onChange({ ...draft, project: { ...draft.project, ...patch } });
  }
  function patchCategory(bi: number, patch: Partial<ParsedIntake['categories'][number]>) {
    const next = [...draft.categories];
    next[bi] = { ...next[bi], ...patch };
    onChange({ ...draft, categories: next });
  }
  function patchLine(
    bi: number,
    li: number,
    patch: Partial<ParsedIntake['categories'][number]['lines'][number]>,
  ) {
    const nextCategories = [...draft.categories];
    const nextLines = [...nextCategories[bi].lines];
    nextLines[li] = { ...nextLines[li], ...patch };
    nextCategories[bi] = { ...nextCategories[bi], lines: nextLines };
    onChange({ ...draft, categories: nextCategories });
  }
  function removeLine(bi: number, li: number) {
    const nextCategories = [...draft.categories];
    nextCategories[bi] = {
      ...nextCategories[bi],
      lines: nextCategories[bi].lines.filter((_, i) => i !== li),
    };
    onChange({ ...draft, categories: nextCategories });
  }
  function removeCategory(bi: number) {
    onChange({ ...draft, categories: draft.categories.filter((_, i) => i !== bi) });
  }

  const sig = draft.signals;

  return (
    <div className="space-y-5">
      {/* Signals */}
      <div className="flex flex-wrap gap-2">
        {sig.competitive ? (
          <Chip tone="amber">
            Competitive
            {sig.competitor_count
              ? ` (${sig.competitor_count} other quote${sig.competitor_count === 1 ? '' : 's'})`
              : ''}
          </Chip>
        ) : null}
        {sig.urgency === 'high' ? <Chip tone="red">High urgency</Chip> : null}
        {sig.upsells.map((u) => (
          <Chip key={u.label} tone="blue">
            Upsell: {u.label} — {u.reason}
          </Chip>
        ))}
        {sig.design_intent.map((d) => (
          <Chip key={d} tone="muted">
            Design: {d}
          </Chip>
        ))}
      </div>

      {/* Customer */}
      <Section title="Customer">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input
              value={draft.customer.name ?? ''}
              onChange={(e) => patchCustomer({ name: e.target.value })}
            />
          </Field>
          <Field label="Phone">
            <Input
              value={draft.customer.phone ?? ''}
              onChange={(e) => patchCustomer({ phone: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <Input
              value={draft.customer.email ?? ''}
              onChange={(e) => patchCustomer({ email: e.target.value })}
            />
          </Field>
          <Field label="Address">
            <Input
              value={draft.customer.address ?? ''}
              onChange={(e) => patchCustomer({ address: e.target.value })}
            />
          </Field>
        </div>
      </Section>

      {/* Project */}
      <Section title="Project">
        <Field label="Name">
          <Input
            value={draft.project.name ?? ''}
            onChange={(e) => patchProject({ name: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <Textarea
            rows={2}
            value={draft.project.description ?? ''}
            onChange={(e) => patchProject({ description: e.target.value })}
          />
        </Field>
      </Section>

      {/* Categories + lines */}
      <Section
        title={`Estimate draft (${draft.categories.length} categor${draft.categories.length === 1 ? 'y' : 'ies'})`}
      >
        {draft.categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No categories extracted.</p>
        ) : (
          <div className="space-y-4">
            {draft.categories.map((b, bi) => (
              <div key={(b as unknown as { _k: string })._k} className="rounded-md border">
                <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
                  <Input
                    value={b.section ?? ''}
                    onChange={(e) => patchCategory(bi, { section: e.target.value || null })}
                    placeholder="Section (optional)"
                    className="h-8 max-w-[180px] text-xs"
                  />
                  <Input
                    value={b.name}
                    onChange={(e) => patchCategory(bi, { name: e.target.value })}
                    placeholder="Category"
                    className="h-8 text-sm font-semibold"
                  />
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => removeCategory(bi)}
                    className="text-destructive hover:text-destructive"
                  >
                    Remove category
                  </Button>
                </div>
                <div className="divide-y">
                  {b.lines.map((l, li) => (
                    <div
                      key={(l as unknown as { _k: string })._k}
                      className="grid grid-cols-12 items-start gap-2 px-3 py-2"
                    >
                      <div className="col-span-12 sm:col-span-5">
                        <Input
                          value={l.label}
                          onChange={(e) => patchLine(bi, li, { label: e.target.value })}
                          placeholder="Line label"
                          className="h-8 text-sm"
                        />
                        <Textarea
                          rows={2}
                          value={l.notes ?? ''}
                          onChange={(e) => patchLine(bi, li, { notes: e.target.value })}
                          placeholder="Notes"
                          className="mt-1 text-xs"
                        />
                      </div>
                      <div className="col-span-3 sm:col-span-2">
                        <Input
                          type="number"
                          step="0.01"
                          value={l.qty}
                          onChange={(e) => patchLine(bi, li, { qty: Number(e.target.value) || 0 })}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="col-span-3 sm:col-span-2">
                        <Input
                          value={l.unit}
                          onChange={(e) => patchLine(bi, li, { unit: e.target.value })}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <Input
                          type="number"
                          step="0.01"
                          value={l.unit_price_cents == null ? '' : l.unit_price_cents / 100}
                          onChange={(e) => {
                            const v = e.target.value;
                            patchLine(bi, li, {
                              unit_price_cents: v === '' ? null : Math.round(Number(v) * 100),
                            });
                          }}
                          placeholder="Price"
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="col-span-2 sm:col-span-1 flex justify-end">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => removeLine(bi, li)}
                          className="text-destructive hover:text-destructive"
                        >
                          Del
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Reply */}
      <Section title="Draft reply">
        <Textarea
          rows={6}
          value={draft.reply_draft}
          onChange={(e) => onChange({ ...draft, reply_draft: e.target.value })}
        />
        <div className="mt-2 flex justify-end">
          <Button type="button" size="sm" variant="outline" onClick={copyReply}>
            Copy reply
          </Button>
        </div>
      </Section>

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <Button type="button" onClick={onAccept} disabled={isAccepting}>
          {isAccepting ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Creating…
            </>
          ) : (
            'Create project'
          )}
        </Button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function Chip({
  tone,
  children,
}: {
  tone: 'amber' | 'red' | 'blue' | 'muted';
  children: React.ReactNode;
}) {
  const cls =
    tone === 'amber'
      ? 'bg-amber-100 text-amber-800'
      : tone === 'red'
        ? 'bg-red-100 text-red-800'
        : tone === 'blue'
          ? 'bg-blue-100 text-blue-800'
          : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

/**
 * Collapsible "What Henry heard" panel — shows the raw Whisper transcript(s)
 * above the customer block on the review screen. Lets the operator see
 * exactly what the model worked from when the category / line-item output
 * comes back thin or wrong.
 */
function TranscriptPanel({ transcript }: { transcript: string }) {
  return (
    <details className="rounded-lg border bg-muted/30 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-muted-foreground">
        What Henry heard
      </summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-foreground">
        {transcript}
      </pre>
    </details>
  );
}
