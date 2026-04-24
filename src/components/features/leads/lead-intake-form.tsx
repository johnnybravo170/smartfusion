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
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ParsedIntake } from '@/lib/ai/intake-prompt';
import { resizeImage } from '@/lib/storage/resize-image';
import { acceptInboundLeadAction, parseInboundLeadAction } from '@/server/actions/intake';

type Phase = 'upload' | 'review';

const RESIZE_THRESHOLD_BYTES = 2 * 1024 * 1024;

async function shrinkIfNeeded(file: File): Promise<File> {
  if (file.type === 'application/pdf') return file;
  if (!file.type.startsWith('image/')) return file;
  if (file.size <= RESIZE_THRESHOLD_BYTES) return file;
  try {
    const blob = await resizeImage(file, { maxDimension: 2048, quality: 0.85 });
    const newName = file.name.replace(/\.(heic|heif|png|webp)$/i, '.jpg');
    return new File([blob], newName || 'image.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export function LeadIntakeForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('upload');
  const [customerName, setCustomerName] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [draft, setDraft] = useState<ParsedIntake | null>(null);
  const [isParsing, startParsing] = useTransition();
  const [isAccepting, startAccepting] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleParse(e: React.FormEvent) {
    e.preventDefault();
    if (!customerName.trim() && files.length === 0 && !pastedText.trim()) {
      toast.error('Add a customer name, image, or pasted text first.');
      return;
    }
    startParsing(async () => {
      const fd = new FormData();
      fd.set('customerName', customerName);
      fd.set('pastedText', pastedText);
      for (const f of files) {
        const shrunk = await shrinkIfNeeded(f);
        fd.append('images', shrunk);
      }
      const res = await parseInboundLeadAction(fd);
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
      setPhase('review');
    });
  }

  function handleAccept() {
    if (!draft) return;
    startAccepting(async () => {
      const res = await acceptInboundLeadAction(draft);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Project created');
      router.push(`/projects/${res.projectId}?tab=estimate`);
    });
  }

  if (phase === 'review' && draft) {
    return (
      <ReviewDraft
        draft={draft}
        onChange={setDraft}
        onBack={() => setPhase('upload')}
        onAccept={handleAccept}
        isAccepting={isAccepting}
      />
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
        <label htmlFor="images" className="mb-1 block text-sm font-medium">
          Screenshots, photos, sketches, PDFs
        </label>
        <input
          id="images"
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="block w-full text-sm file:mr-3 file:rounded file:border file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted/80"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        {files.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {files.length} file{files.length === 1 ? '' : 's'} ready.
          </p>
        ) : null}
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
                      <div className="col-span-3 sm:col-span-1">
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
                      <div className="col-span-4 sm:col-span-3">
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
