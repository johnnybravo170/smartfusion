'use client';

/**
 * Drop-zone + click-to-pick document uploader for the project Documents
 * tab. Each upload picks one file and a category up-front (since
 * categorization is the whole point — we want manuals, warranties,
 * permits filed correctly, not piled into "other").
 *
 * Files larger than 25 MB are rejected client-side before the upload
 * fires.
 */

import { Loader2, Upload } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DOCUMENT_TYPES,
  type DocumentType,
  documentTypeLabels,
} from '@/lib/validators/project-document';
import {
  classifyDocumentTypeAction,
  uploadProjectDocumentAction,
} from '@/server/actions/project-documents';

const MAX_BYTES = 25 * 1024 * 1024;

export function DocumentUpload({
  projectId,
  suppliers = [],
}: {
  projectId: string;
  /** Optional sub-trade / vendor contacts available for linking. */
  suppliers?: Array<{ id: string; name: string; kind: string }>;
}) {
  const [type, setType] = useState<DocumentType>('warranty');
  const [title, setTitle] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [notes, setNotes] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function pickFile() {
    fileRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input first so picking the same file again still fires
    // onChange, even if classifier+submit takes time.
    if (fileRef.current) fileRef.current.value = '';

    // Henry classifier runs first — gives us a better Type guess to
    // show in the dropdown AND to ride along on the upload itself, so
    // the doc lands in the right category without the operator
    // intervening. Cheap regex catches most filenames in <10ms; Claude
    // fallback adds a small delay only on ambiguous names.
    let chosenType = type;
    try {
      const res = await classifyDocumentTypeAction({ filename: file.name });
      if (res.ok && (DOCUMENT_TYPES as readonly string[]).includes(res.type)) {
        chosenType = res.type as DocumentType;
        if (chosenType !== type) setType(chosenType);
      }
    } catch {
      // Fall through to whatever the operator had selected.
    }
    submit(file, chosenType);
  }

  function submit(file: File, overrideType?: DocumentType) {
    if (file.size > MAX_BYTES) {
      toast.error('File is larger than 25 MB.');
      return;
    }
    const fd = new FormData();
    fd.set('file', file);
    fd.set('project_id', projectId);
    fd.set('type', overrideType ?? type);
    fd.set('title', title || file.name);
    fd.set('expires_at', expiresAt);
    fd.set('notes', notes);
    fd.set('supplier_id', supplierId);

    startTransition(async () => {
      const res = await uploadProjectDocumentAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Uploaded ${file.name}`);
      // Clear metadata for the next upload (keep type sticky — operators
      // typically batch-upload one category at a time).
      setTitle('');
      setExpiresAt('');
      setNotes('');
    });
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Upload document</h3>
        <p className="text-xs text-muted-foreground">
          Contracts, permits, warranties, manuals, inspections — your homeowner sees them on their
          portal and they roll into the Home Record.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="doc-type" className="mb-1.5 block">
            Category
          </Label>
          <select
            id="doc-type"
            value={type}
            onChange={(e) => setType(e.target.value as DocumentType)}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            disabled={pending}
          >
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {documentTypeLabels[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="doc-title" className="mb-1.5 block">
            Title (optional)
          </Label>
          <Input
            id="doc-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Defaults to filename"
            disabled={pending}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="doc-expires" className="mb-1.5 block">
            Expires (optional)
          </Label>
          <Input
            id="doc-expires"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            disabled={pending}
          />
        </div>
        <div>
          <Label htmlFor="doc-notes" className="mb-1.5 block">
            Notes (optional)
          </Label>
          <Input
            id="doc-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={pending}
          />
        </div>
      </div>

      {suppliers.length > 0 ? (
        <div>
          <Label htmlFor="doc-supplier" className="mb-1.5 block">
            Sub-trade / vendor (optional)
          </Label>
          <select
            id="doc-supplier"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            disabled={pending}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="">— none —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.kind ? ` (${s.kind})` : ''}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Linking to a sub-trade adds them to the homeowner&rsquo;s &ldquo;Trade contacts&rdquo;
            list on the portal.
          </p>
        </div>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        onChange={onFileChosen}
        disabled={pending}
      />
      <Button type="button" onClick={pickFile} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        Pick file & upload
      </Button>
    </div>
  );
}
