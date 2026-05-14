'use client';

/**
 * Confirm dialog for a customer message (scope change, complaint, question)
 * forwarded into the universal inbox.
 *
 * Operator picks the project + edits the body (pre-filled from the draft's
 * formatted pasted_text); applyIntakeIntentAction(intent='message') inserts
 * a project_messages row (channel='email', direction='inbound') so the
 * project conversation thread sees it.
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

export function StagedMessageDialog({
  open,
  onOpenChange,
  draftId,
  projects,
  defaultProjectId,
  defaultSubject,
  defaultBody,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  draftId: string;
  projects: ProjectOption[];
  defaultProjectId: string | null;
  defaultSubject?: string;
  defaultBody?: string;
  onApplied: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [subject, setSubject] = useState(defaultSubject ?? '');
  const [body, setBody] = useState(defaultBody ?? '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      toast.error('Pick a project.');
      return;
    }
    if (!body.trim()) {
      toast.error('Body cannot be empty.');
      return;
    }
    startTransition(async () => {
      const result = await applyIntakeIntentAction({
        draftId,
        intent: 'message',
        projectId,
        fields: {
          subject: subject.trim() || undefined,
          body: body.trim(),
        },
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Message added to project thread.');
      onApplied();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to project thread</DialogTitle>
          <DialogDescription>
            File the forwarded customer message into the project conversation log so it shows up in
            the Messages tab.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label htmlFor="msg-project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={pending}>
              <SelectTrigger id="msg-project">
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
            <Label htmlFor="msg-subject">Subject</Label>
            <Input
              id="msg-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Optional"
              disabled={pending}
            />
          </div>

          <div>
            <Label htmlFor="msg-body">Body</Label>
            <Textarea
              id="msg-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="The customer's message…"
              rows={8}
              required
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
              {pending ? 'Applying…' : 'Add to thread'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
