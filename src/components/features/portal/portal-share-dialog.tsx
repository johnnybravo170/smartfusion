'use client';

/**
 * Email-the-portal-link dialog.
 *
 * Replaces the prior fire-on-click "Share with Customer" button with a
 * preview-first flow matching the estimate-send pattern. Operator picks
 * recipients (primary + additional_emails, all pre-checked), optionally
 * adds a note, and confirms.
 */

import { Loader2, Mail } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { sendPortalInviteAction } from '@/server/actions/portal-updates';

export function PortalShareDialog({
  projectId,
  primaryEmail,
  additionalEmails,
  customerName,
  projectName,
}: {
  projectId: string;
  primaryEmail: string | null;
  additionalEmails: string[];
  customerName: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);

  // Build the deduped recipient list once. Primary first, then additionals.
  const allRecipients = Array.from(
    new Set(
      [primaryEmail, ...additionalEmails]
        .filter((e): e is string => Boolean(e?.trim()))
        .map((e) => e.trim().toLowerCase()),
    ),
  );

  const [selected, setSelected] = useState<Set<string>>(new Set(allRecipients));
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();

  // Reset selection state whenever the dialog opens — picks up changes
  // to the customer record between opens. allRecipients is recomputed
  // from props every render but its identity changes, which would
  // re-fire the effect on every render; keying on `open` only is the
  // intent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on open transition only
  useEffect(() => {
    if (open) {
      setSelected(new Set(allRecipients));
      setNote('');
    }
  }, [open]);

  function toggle(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function handleSend() {
    const recipientEmails = Array.from(selected);
    if (recipientEmails.length === 0) {
      toast.error('Pick at least one recipient.');
      return;
    }
    startTransition(async () => {
      const res = await sendPortalInviteAction({
        projectId,
        recipientEmails,
        note: note.trim() || null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        recipientEmails.length === 1
          ? `Portal link sent to ${recipientEmails[0]}.`
          : `Portal link sent to ${recipientEmails.length} recipients.`,
      );
      setOpen(false);
    });
  }

  const noEmails = allRecipients.length === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
          disabled={noEmails}
          title={noEmails ? 'Customer has no email on file' : undefined}
        >
          <Mail className="size-3.5" />
          Email portal link
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Email portal link</DialogTitle>
          <DialogDescription>
            Sends {customerName || 'the customer'} the portal link for{' '}
            <span className="font-medium">{projectName}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium">Send to</p>
            {allRecipients.length === 0 ? (
              <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                Customer has no email on file. Add one on their contact record.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {allRecipients.map((email) => (
                  <li key={email}>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.has(email)}
                        onChange={() => toggle(email)}
                        className="size-4 rounded border-gray-300"
                      />
                      <span className="font-mono text-xs">{email}</span>
                      {email === primaryEmail?.toLowerCase() ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          Primary
                        </span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <label htmlFor="portal-share-note" className="mb-1 block text-xs font-medium">
              Add a note <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="portal-share-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Hi — here's the portal for our project. Bookmark it!"
              rows={3}
              className="resize-none text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Appears as a quoted block in the email above the &ldquo;View Your Project&rdquo;
              button.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSend} disabled={pending || selected.size === 0}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Mail className="size-3.5" />
            )}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
