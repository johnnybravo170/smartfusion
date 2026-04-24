'use client';

/**
 * Inbound lead intake — operator drops screenshots + photos + an
 * optional pasted message, Henry returns a draft estimate, operator
 * tweaks and accepts. Two phases live in one component:
 *   phase = 'upload' → form
 *   phase = 'review' → editable draft + Accept
 */

import { Loader2 } from 'lucide-react';
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
import { resizeImage } from '@/lib/storage/resize-image';
import { createClient as createBrowserSupabase } from '@/lib/supabase/client';
import {
  acceptInboundLeadAction,
  type ParseModelChoice,
  parseInboundLeadAction,
} from '@/server/actions/intake';

type Phase = 'upload' | 'review';

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

export function LeadIntakeForm({ parseModel = 'gpt-4.1' }: { parseModel?: ParseModelChoice } = {}) {
  usePreventDefaultWindowDrop();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('upload');
  const [customerName, setCustomerName] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [draft, setDraft] = useState<ParsedIntake | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<ContactMatch[]>([]);
  const [isParsing, startParsing] = useTransition();
  const [isAccepting, startAccepting] = useTransition();

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
      // client uploads into the `intake-audio` bucket (yes, name now
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
          // Path layout matches the bucket RLS: foldername[2] = auth.uid().
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
        return;
      }
      // Tag every bucket and line with a stable runtime key so React
      // diffing stays sane through edits and removals.
      const stamped: ParsedIntake = {
        ...res.draft,
        buckets: res.draft.buckets.map((b) => ({
          ...b,
          _k: crypto.randomUUID(),
          lines: b.lines.map((l) => ({ ...l, _k: crypto.randomUUID() })),
        })) as ParsedIntake['buckets'],
      };
      setDraft(stamped);
      setTranscript(res.transcript ?? null);
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

  function handleAccept(options?: { useExistingContactId?: string; confirmCreate?: boolean }) {
    if (!draft) return;
    startAccepting(async () => {
      const res = await acceptInboundLeadAction(draft, options);
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
        {transcript ? <TranscriptPanel transcript={transcript} /> : null}
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
  function patchBucket(bi: number, patch: Partial<ParsedIntake['buckets'][number]>) {
    const next = [...draft.buckets];
    next[bi] = { ...next[bi], ...patch };
    onChange({ ...draft, buckets: next });
  }
  function patchLine(
    bi: number,
    li: number,
    patch: Partial<ParsedIntake['buckets'][number]['lines'][number]>,
  ) {
    const nextBuckets = [...draft.buckets];
    const nextLines = [...nextBuckets[bi].lines];
    nextLines[li] = { ...nextLines[li], ...patch };
    nextBuckets[bi] = { ...nextBuckets[bi], lines: nextLines };
    onChange({ ...draft, buckets: nextBuckets });
  }
  function removeLine(bi: number, li: number) {
    const nextBuckets = [...draft.buckets];
    nextBuckets[bi] = {
      ...nextBuckets[bi],
      lines: nextBuckets[bi].lines.filter((_, i) => i !== li),
    };
    onChange({ ...draft, buckets: nextBuckets });
  }
  function removeBucket(bi: number) {
    onChange({ ...draft, buckets: draft.buckets.filter((_, i) => i !== bi) });
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

      {/* Buckets + lines */}
      <Section
        title={`Estimate draft (${draft.buckets.length} bucket${draft.buckets.length === 1 ? '' : 's'})`}
      >
        {draft.buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No buckets extracted.</p>
        ) : (
          <div className="space-y-4">
            {draft.buckets.map((b, bi) => (
              <div key={(b as unknown as { _k: string })._k} className="rounded-md border">
                <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
                  <Input
                    value={b.section ?? ''}
                    onChange={(e) => patchBucket(bi, { section: e.target.value || null })}
                    placeholder="Section (optional)"
                    className="h-8 max-w-[180px] text-xs"
                  />
                  <Input
                    value={b.name}
                    onChange={(e) => patchBucket(bi, { name: e.target.value })}
                    placeholder="Bucket"
                    className="h-8 text-sm font-semibold"
                  />
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => removeBucket(bi)}
                    className="text-destructive hover:text-destructive"
                  >
                    Remove bucket
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
 * exactly what the model worked from when the bucket / line-item output
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
