'use client';

/**
 * Universal new-contact intake. Same drop-zone UX for every kind: files,
 * pasted text, and a name hint. For kind=customer the form delegates to
 * the existing `LeadIntakeForm` (estimate-scaffolding path). For every
 * other kind (vendor, sub, agent, inspector, referral, other) it runs a
 * lightweight contact-only parser and lands on a review screen with the
 * extracted fields.
 */

import { Contact as ContactIcon, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ExistingMatchesBanner } from '@/components/features/contacts/existing-matches-banner';
import { IntakeDropzone } from '@/components/features/contacts/intake-dropzone';
import { LeadIntakeForm } from '@/components/features/leads/lead-intake-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ParsedContact } from '@/lib/ai/contact-intake-prompt';
import {
  contactPickerSupported,
  importedContactToPastedText,
  isVCardFile,
  parseVCardFile,
  pickPhoneContact,
} from '@/lib/contacts/import-helpers';
import type { ContactMatch } from '@/lib/db/queries/contact-matches';
import { resizeImage } from '@/lib/storage/resize-image';
import { type ContactKind, contactKindLabels, contactKinds } from '@/lib/validators/customer';
import {
  acceptInboundContactAction,
  attachIntakeToContactAction,
  type NonCustomerKind,
  parseInboundContactAction,
} from '@/server/actions/contact-intake';

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

export function ContactIntakeForm({ initialKind }: { initialKind?: ContactKind }) {
  const [kind, setKind] = useState<ContactKind>(initialKind ?? 'customer');

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border bg-card p-4">
        <label htmlFor="intake-kind" className="mb-1 block text-sm font-medium">
          Kind
        </label>
        <Select value={kind} onValueChange={(v) => setKind(v as ContactKind)}>
          <SelectTrigger id="intake-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {contactKinds.map((k) => (
              <SelectItem key={k} value={k}>
                {contactKindLabels[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-2 text-xs text-muted-foreground">
          {kind === 'customer'
            ? 'Drop screenshots, photos, or PDFs. Henry builds a starting estimate you can accept as a new project — or skip the estimate and just save the customer.'
            : 'Drop a business card, email signature, letterhead, or paste contact info. Henry extracts the contact details only — no estimate scaffolding.'}
        </p>
      </div>

      {kind === 'customer' ? <LeadIntakeForm /> : <NonCustomerIntake kind={kind} />}
    </div>
  );
}

function NonCustomerIntake({ kind }: { kind: NonCustomerKind }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('upload');
  const [nameHint, setNameHint] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [draft, setDraft] = useState<ParsedContact | null>(null);
  const [matches, setMatches] = useState<ContactMatch[]>([]);
  const [isParsing, startParsing] = useTransition();
  const [isAccepting, startAccepting] = useTransition();
  const [pickerAvailable, setPickerAvailable] = useState(false);

  const kindLabel = useMemo(() => contactKindLabels[kind], [kind]);

  // Feature-detect the Contact Picker API on mount (Chrome Android only).
  useEffect(() => {
    setPickerAvailable(contactPickerSupported());
  }, []);

  function mergePastedText(next: string) {
    setPastedText((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}\n${next}` : next;
    });
  }

  async function handleImportFromPhone() {
    const c = await pickPhoneContact();
    if (!c) return;
    if (c.name && !nameHint.trim()) setNameHint(c.name);
    mergePastedText(importedContactToPastedText(c));
    toast.success('Contact imported from phone.');
  }

  async function handleFilesAdded(picked: File[]) {
    if (picked.length === 0) return;
    // vCards are parsed client-side and merged into the pasted-text field
    // rather than sent to the AI as an artifact. Works everywhere, which
    // is the iOS-Safari fallback for the Contact Picker API.
    const [vcards, others] = [picked.filter(isVCardFile), picked.filter((f) => !isVCardFile(f))];
    if (vcards.length) {
      for (const v of vcards) {
        const c = await parseVCardFile(v);
        if (c) {
          if (c.name && !nameHint.trim()) setNameHint(c.name);
          mergePastedText(importedContactToPastedText(c));
        }
      }
      toast.success(`Imported ${vcards.length} vCard${vcards.length === 1 ? '' : 's'}.`);
    }
    if (others.length) {
      setFiles((prev) => [...prev, ...others]);
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleParse(e: React.FormEvent) {
    e.preventDefault();
    if (!nameHint.trim() && !pastedText.trim() && files.length === 0) {
      toast.error('Drop a file, paste text, or type a name first.');
      return;
    }
    startParsing(async () => {
      const fd = new FormData();
      fd.set('kind', kind);
      fd.set('name', nameHint);
      fd.set('pastedText', pastedText);
      for (const f of files) {
        const shrunk = await shrinkIfNeeded(f);
        fd.append('files', shrunk);
      }
      const res = await parseInboundContactAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setDraft(res.draft);
      setMatches(res.matches);
      setPhase('review');
    });
  }

  function handleAccept() {
    if (!draft) return;
    startAccepting(async () => {
      const res = await acceptInboundContactAction({ kind, draft });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${kindLabel} added.`);
      router.push(`/contacts/${res.contactId}`);
    });
  }

  function handleAttach(contactId: string) {
    if (!draft) return;
    startAccepting(async () => {
      const res = await attachIntakeToContactAction({ contactId, draft });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Attached to existing contact.');
      router.push(`/contacts/${res.contactId}`);
    });
  }

  if (phase === 'review' && draft) {
    return (
      <ReviewContactDraft
        draft={draft}
        onChange={setDraft}
        matches={matches}
        onBack={() => setPhase('upload')}
        onAccept={handleAccept}
        onAttach={handleAttach}
        isAccepting={isAccepting}
        kindLabel={kindLabel}
      />
    );
  }

  return (
    <form onSubmit={handleParse} className="space-y-4 rounded-lg border bg-card p-5">
      {pickerAvailable ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleImportFromPhone}
          className="w-full sm:w-auto"
        >
          <ContactIcon className="mr-1.5 size-3.5" />
          Import from phone contacts
        </Button>
      ) : null}

      <div>
        <label htmlFor="intake-name-hint" className="mb-1 block text-sm font-medium">
          Name hint (optional)
        </label>
        <Input
          id="intake-name-hint"
          value={nameHint}
          onChange={(e) => setNameHint(e.target.value)}
          placeholder={
            kind === 'vendor'
              ? 'e.g. Home Depot Pro'
              : kind === 'sub'
                ? "e.g. Joe's Plumbing"
                : kind === 'agent'
                  ? 'e.g. Helen Fraser (ReMax)'
                  : 'Name'
          }
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Leave blank if Henry can read it from the artifact.
        </p>
      </div>

      <div>
        <p className="mb-1 block text-sm font-medium">Drop files</p>
        <IntakeDropzone
          files={files}
          onFilesAdded={handleFilesAdded}
          onRemove={removeFile}
          accept="image/*,application/pdf,.vcf,text/vcard,text/x-vcard"
          multiple
          disabled={isParsing}
          inputId="intake-files"
          hint="Drag in a business card photo, letterhead, invoice, or .vcf vCard — or click to choose."
        />
      </div>

      <div>
        <label htmlFor="intake-pasted" className="mb-1 block text-sm font-medium">
          Or paste contact info
        </label>
        <Textarea
          id="intake-pasted"
          rows={4}
          value={pastedText}
          onChange={(e) => setPastedText(e.target.value)}
          placeholder="Paste an email signature, a text message, or a few lines about the contact."
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

function ReviewContactDraft({
  draft,
  onChange,
  matches,
  onBack,
  onAccept,
  onAttach,
  isAccepting,
  kindLabel,
}: {
  draft: ParsedContact;
  onChange: (d: ParsedContact) => void;
  matches: ContactMatch[];
  onBack: () => void;
  onAccept: () => void;
  onAttach: (contactId: string) => void;
  isAccepting: boolean;
  kindLabel: string;
}) {
  function patch(next: Partial<ParsedContact>) {
    onChange({ ...draft, ...next });
  }

  return (
    <div className="space-y-5">
      {matches.length > 0 ? (
        <ExistingMatchesBanner
          matches={matches}
          onUseExisting={onAttach}
          useLabel="Attach to this"
        />
      ) : null}

      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{kindLabel} — review</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input
              value={draft.name ?? ''}
              onChange={(e) => patch({ name: e.target.value || null })}
            />
          </Field>
          <Field label="Phone">
            <Input
              value={draft.phone ?? ''}
              onChange={(e) => patch({ phone: e.target.value || null })}
            />
          </Field>
          <Field label="Email">
            <Input
              value={draft.email ?? ''}
              onChange={(e) => patch({ email: e.target.value || null })}
            />
          </Field>
          <Field label="Website">
            <Input
              value={draft.website ?? ''}
              onChange={(e) => patch({ website: e.target.value || null })}
            />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Input
              value={draft.address ?? ''}
              onChange={(e) => patch({ address: e.target.value || null })}
            />
          </Field>
          <Field label="City">
            <Input
              value={draft.city ?? ''}
              onChange={(e) => patch({ city: e.target.value || null })}
            />
          </Field>
          <Field label="Province">
            <Input
              value={draft.province ?? ''}
              onChange={(e) => patch({ province: e.target.value || null })}
            />
          </Field>
          <Field label="Postal code">
            <Input
              value={draft.postal_code ?? ''}
              onChange={(e) => patch({ postal_code: e.target.value || null })}
            />
          </Field>
          <Field label="Trade">
            <Input
              value={draft.trade ?? ''}
              onChange={(e) => patch({ trade: e.target.value || null })}
              placeholder="Sub-trade only (e.g. electrical, plumbing)"
            />
          </Field>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">Notes</h2>
        <Textarea
          rows={6}
          value={draft.notes}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Saved as the first entry in the contact&rsquo;s notes feed.
        </p>
      </div>

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
            `Create ${kindLabel.toLowerCase()}`
          )}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
