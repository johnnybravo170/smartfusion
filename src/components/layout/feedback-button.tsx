'use client';

/**
 * Floating "?" feedback button. One click opens a small modal where the
 * user types a quick bug report or idea — submit fires
 * `submitFeedbackAction`, which lands a kanban card on ops dev/backlog
 * tagged for the scheduled triage agent.
 *
 * Position: stacked above the existing ChatToggle so they don't overlap.
 * ChatToggle is bottom-{4,6} right-{4,6}; this sits one button-height up.
 */

import { Lightbulb } from 'lucide-react';
import { usePathname } from 'next/navigation';
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
import { Textarea } from '@/components/ui/textarea';
import { submitFeedbackAction } from '@/server/actions/feedback';

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [pending, startTransition] = useTransition();
  const pathname = usePathname();

  function handleSubmit() {
    const message = text.trim();
    if (!message) return;
    startTransition(async () => {
      const res = await submitFeedbackAction({
        message,
        url: typeof window !== 'undefined' ? window.location.href : (pathname ?? undefined),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      });
      if (!res.ok) {
        toast.error(`Could not send: ${res.error}`);
        return;
      }
      toast.success('Sent — thanks. Henry will triage and report back.');
      setText('');
      setOpen(false);
    });
  }

  return (
    <>
      <button
        type="button"
        aria-label="Send feedback"
        onClick={() => setOpen(true)}
        className="fixed bottom-20 right-4 z-50 flex size-10 items-center justify-center rounded-full border bg-background text-foreground shadow-md transition-transform hover:scale-105 active:scale-95 sm:bottom-24 sm:right-6 sm:size-12"
      >
        <Lightbulb className="size-4 sm:size-5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send Henry a note</DialogTitle>
            <DialogDescription>
              Bug report, idea, anything. Lands on the dev kanban with this page&apos;s URL
              attached. Henry will triage and reply on the card.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What's up?"
            rows={5}
            disabled={pending}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={pending || !text.trim()}>
              {pending ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
