'use client';

/**
 * Confirm dialog for a photo (damage / progress / reference / inspiration)
 * forwarded into the universal inbox.
 *
 * Operator picks the project + tag + optional caption; applyIntakeIntentAction
 * (intent='photo') copies the artifact from intake-audio → photos bucket and
 * inserts a photos row visible in the project Gallery.
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
import { applyIntakeIntentAction } from '@/server/actions/inbox-intake';

type ProjectOption = { id: string; name: string };
type PhotoTag = 'before' | 'after' | 'progress' | 'other';

const TAGS: { value: PhotoTag; label: string }[] = [
  { value: 'progress', label: 'Progress' },
  { value: 'before', label: 'Before' },
  { value: 'after', label: 'After' },
  { value: 'other', label: 'Other' },
];

export function StagedPhotoDialog({
  open,
  onOpenChange,
  draftId,
  artifact,
  projects,
  defaultProjectId,
  defaultCaption,
  defaultTag = 'other',
  onApplied,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  draftId: string;
  artifact: { path: string; mime: string };
  projects: ProjectOption[];
  defaultProjectId: string | null;
  defaultCaption?: string;
  defaultTag?: PhotoTag;
  onApplied: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [caption, setCaption] = useState(defaultCaption ?? '');
  const [tag, setTag] = useState<PhotoTag>(defaultTag);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      toast.error('Pick a project.');
      return;
    }
    startTransition(async () => {
      const result = await applyIntakeIntentAction({
        draftId,
        intent: 'photo',
        projectId,
        fields: {
          caption: caption.trim() || undefined,
          tag,
          artifactPath: artifact.path,
          artifactMime: artifact.mime,
        },
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Photo added to project gallery.');
      onApplied();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to project gallery</DialogTitle>
          <DialogDescription>
            File the forwarded photo into the project&rsquo;s photo gallery with a tag.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label htmlFor="photo-project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={pending}>
              <SelectTrigger id="photo-project">
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

          <div>
            <Label htmlFor="photo-tag">Tag</Label>
            <Select value={tag} onValueChange={(v) => setTag(v as PhotoTag)} disabled={pending}>
              <SelectTrigger id="photo-tag">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TAGS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="photo-caption">Caption</Label>
            <Input
              id="photo-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Optional"
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
              {pending ? 'Applying…' : 'Add to gallery'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
