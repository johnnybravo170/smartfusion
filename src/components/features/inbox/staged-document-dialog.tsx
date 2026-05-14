'use client';

/**
 * Confirm dialog for an attached document (permit, contract, drawing, etc.)
 * forwarded into the universal inbox.
 *
 * Operator picks the project + document type + title, hits Apply, and
 * applyIntakeIntentAction(intent='document') copies the artifact from the
 * intake-audio bucket into project-docs and inserts a project_documents row.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { applyIntakeIntentAction } from '@/server/actions/inbox-intake';

type ProjectOption = { id: string; name: string };
type DocumentType = 'contract' | 'permit' | 'warranty' | 'manual' | 'inspection' | 'coi' | 'other';

const DOC_TYPES: { value: DocumentType; label: string }[] = [
  { value: 'permit', label: 'Permit' },
  { value: 'contract', label: 'Contract' },
  { value: 'warranty', label: 'Warranty' },
  { value: 'manual', label: 'Manual' },
  { value: 'inspection', label: 'Inspection report' },
  { value: 'coi', label: 'COI (insurance)' },
  { value: 'other', label: 'Other' },
];

export function StagedDocumentDialog({
  open,
  onOpenChange,
  draftId,
  artifact,
  projects,
  defaultProjectId,
  defaultTitle,
  defaultType = 'other',
  onApplied,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  draftId: string;
  artifact: { path: string; mime: string; bytes?: number };
  projects: ProjectOption[];
  defaultProjectId: string | null;
  defaultTitle?: string;
  defaultType?: DocumentType;
  onApplied: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [docType, setDocType] = useState<DocumentType>(defaultType);
  const [notes, setNotes] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      toast.error('Pick a project.');
      return;
    }
    if (!title.trim()) {
      toast.error('Give the document a title.');
      return;
    }
    startTransition(async () => {
      const result = await applyIntakeIntentAction({
        draftId,
        intent: 'document',
        projectId,
        fields: {
          title: title.trim(),
          type: docType,
          notes: notes.trim() || undefined,
          artifactPath: artifact.path,
          artifactMime: artifact.mime,
          artifactBytes: artifact.bytes,
        },
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Document attached to project.');
      onApplied();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach as project document</DialogTitle>
          <DialogDescription>
            File the forwarded attachment under the project&rsquo;s documents bundle.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label htmlFor="doc-project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={pending}>
              <SelectTrigger id="doc-project">
                <SelectValue placeholder="Pick project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="doc-title">Title</Label>
              <Input
                id="doc-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. City of Vancouver permit — 1234 Main St"
                required
                disabled={pending}
              />
            </div>
            <div>
              <Label htmlFor="doc-type">Type</Label>
              <Select
                value={docType}
                onValueChange={(v) => setDocType(v as DocumentType)}
                disabled={pending}
              >
                <SelectTrigger id="doc-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="doc-notes">Notes</Label>
            <Textarea
              id="doc-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
              rows={2}
              disabled={pending}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Applying…' : 'Attach to project'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
