'use client';

/**
 * Owner-only inline verify / reject controls for a `done` task. Drops into
 * the "To Verify" dashboard list and the project task list (next to any
 * row showing status='done'). Reject opens a modal with a required note
 * field — owners must explain what needs more work so the crew has a
 * paper trail to act on.
 */

import { Loader2 } from 'lucide-react';
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
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { rejectVerificationAction, verifyTaskAction } from '@/server/actions/tasks';

const MIN_NOTE_LENGTH = 5;

export function VerifyTaskButtons({
  taskId,
  compact = false,
}: {
  taskId: string;
  compact?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState('');

  function onVerify() {
    startTransition(async () => {
      const res = await verifyTaskAction(taskId);
      if (!res.ok) toast.error(res.error);
      else toast.success('Verified.');
    });
  }

  function onSubmitReject(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = note.trim();
    if (trimmed.length < MIN_NOTE_LENGTH) return;
    startTransition(async () => {
      const res = await rejectVerificationAction(taskId, trimmed);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Sent back to crew.');
      setRejectOpen(false);
      setNote('');
    });
  }

  const trimmedLength = note.trim().length;
  const noteValid = trimmedLength >= MIN_NOTE_LENGTH;

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          size={compact ? 'sm' : 'default'}
          variant="default"
          onClick={onVerify}
          disabled={pending}
        >
          Verify
        </Button>
        <button
          type="button"
          onClick={() => setRejectOpen(true)}
          disabled={pending}
          className="text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50"
        >
          Reject
        </button>
      </div>

      <Dialog
        open={rejectOpen}
        onOpenChange={(o) => {
          if (pending) return;
          setRejectOpen(o);
          if (!o) setNote('');
        }}
      >
        <DialogContent>
          <form onSubmit={onSubmitReject}>
            <DialogHeader>
              <DialogTitle>Send back to crew</DialogTitle>
              <DialogDescription>
                Tell them what needs more work. The note shows up on the task so they know what to
                fix.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-2">
              <Label htmlFor="reject-note">Note</Label>
              <Textarea
                id="reject-note"
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Trim around the window needs another coat."
                rows={4}
                disabled={pending}
                required
                minLength={MIN_NOTE_LENGTH}
              />
            </div>
            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRejectOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={pending || !noteValid}>
                {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Reject
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
