'use client';

/**
 * Dialog that opens the note-creation form. Submits via the
 * `createWorklogNoteAction` server action; on success the dialog closes and
 * the page revalidates so the new entry shows up at the top of the list.
 */

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import {
  type WorklogRelatedType,
  worklogRelatedTypeLabels,
  worklogRelatedTypes,
} from '@/lib/validators/worklog';
import { createWorklogNoteAction } from '@/server/actions/worklog';

const UNSET = '__none';

export function AddNoteDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [relatedType, setRelatedType] = useState<WorklogRelatedType | typeof UNSET>(UNSET);
  const [relatedId, setRelatedId] = useState('');
  const titleId = useId();
  const bodyId = useId();
  const relatedTypeId = useId();
  const relatedIdId = useId();

  function reset() {
    setTitle('');
    setBody('');
    setRelatedType(UNSET);
    setRelatedId('');
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error('Give your note a title.');
      return;
    }
    startTransition(async () => {
      const result = await createWorklogNoteAction({
        title: trimmedTitle,
        body: body.trim() || undefined,
        related_type: relatedType === UNSET ? undefined : relatedType,
        related_id: relatedId || undefined,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Note added to work log.');
      reset();
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-3.5" />
          Add note
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add a work log note</DialogTitle>
            <DialogDescription>
              Jot something down. Notes show up in the reverse-chronological feed alongside system
              events.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Customer visit notes"
              autoFocus
              disabled={pending}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={bodyId}>Body</Label>
            <Textarea
              id={bodyId}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What happened? What do you want to remember?"
              rows={5}
              disabled={pending}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={relatedTypeId}>Related to</Label>
              <Select
                value={relatedType}
                onValueChange={(v) => setRelatedType(v as WorklogRelatedType | typeof UNSET)}
                disabled={pending}
              >
                <SelectTrigger id={relatedTypeId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSET}>None</SelectItem>
                  {worklogRelatedTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {worklogRelatedTypeLabels[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={relatedIdId}>Related id</Label>
              <Input
                id={relatedIdId}
                value={relatedId}
                onChange={(e) => setRelatedId(e.target.value)}
                placeholder="UUID"
                disabled={pending || relatedType === UNSET}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !title.trim()}>
              {pending ? 'Saving…' : 'Save note'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
