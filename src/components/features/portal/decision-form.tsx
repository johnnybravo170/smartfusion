'use client';

/**
 * Operator form for creating a new homeowner decision request. Lives
 * in the project detail Portal tab. V1 supports label, optional
 * description, optional due date — photo refs are V2 (decisions can
 * link to existing project photos via photo IDs once that picker
 * exists).
 */

import { Loader2, Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { createDecisionAction } from '@/server/actions/project-decisions';

export function DecisionForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [optionsText, setOptionsText] = useState('');
  const [pending, startTransition] = useTransition();

  function reset() {
    setLabel('');
    setDescription('');
    setDueDate('');
    setOptionsText('');
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Split the textarea into individual options. Newline-or-comma
    // separated, trimmed, deduplicated, max ~10 options.
    const optionsList = Array.from(
      new Set(
        optionsText
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ).slice(0, 10);
    startTransition(async () => {
      const res = await createDecisionAction({
        projectId,
        label,
        description: description || null,
        dueDate: dueDate || null,
        options: optionsList.length > 0 ? optionsList : undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Decision posted to portal');
      reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Plus className="size-4" />
          New decision
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request a homeowner decision</DialogTitle>
          <DialogDescription>
            The homeowner sees this at the top of their portal. They can Approve, Decline, or Ask a
            question.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label htmlFor="decision-label">What needs deciding</Label>
            <Input
              id="decision-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Approve allowance bump for tile"
              required
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="decision-description">Context (optional)</Label>
            <Textarea
              id="decision-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why this matters, what changes if they say no, etc."
              rows={4}
            />
          </div>
          <div>
            <Label htmlFor="decision-due">Due date (optional)</Label>
            <Input
              id="decision-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="decision-options">Options (optional, one per line)</Label>
            <Textarea
              id="decision-options"
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              placeholder={'Simply White\nChantilly Lace\nDecorator\u2019s White'}
              rows={3}
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Leave blank for a binary Approve / Decline. Listing options shows the homeowner radio
              buttons + a Confirm button.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !label.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Post to portal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
