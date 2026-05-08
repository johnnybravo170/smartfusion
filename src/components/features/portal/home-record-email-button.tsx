'use client';

/**
 * "Email to homeowner" button for the Home Record. Opens a confirm
 * dialog so the operator sees which email it's going to and which
 * delivery formats will be linked. Re-running re-sends.
 *
 * The customer email is the one stored in the snapshot (frozen at
 * generation time). If the operator wants to send to a different
 * address, they can override it in the dialog.
 */

import { CheckCircle2, Loader2, Mail } from 'lucide-react';
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
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import { emailHomeRecordAction } from '@/server/actions/home-records';

type Props = {
  projectId: string;
  defaultEmail: string | null;
  hasPdf: boolean;
  hasZip: boolean;
  emailedAt: string | null;
  emailedTo: string | null;
};

export function HomeRecordEmailButton({
  projectId,
  defaultEmail,
  hasPdf,
  hasZip,
  emailedAt,
  emailedTo,
}: Props) {
  const tz = useTenantTimezone();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [pending, startTransition] = useTransition();

  function send() {
    startTransition(async () => {
      const res = await emailHomeRecordAction(projectId, {
        overrideEmail: email !== defaultEmail ? email : undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Sent to ${res.emailedTo}`);
      setOpen(false);
    });
  }

  const alreadySent = Boolean(emailedAt);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {alreadySent ? <CheckCircle2 className="size-4" /> : <Mail className="size-4" />}
          {alreadySent ? 'Resend email' : 'Email to homeowner'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Email Home Record to homeowner</DialogTitle>
          <DialogDescription>
            Sends a single email with the permanent web link
            {hasPdf ? ', the PDF download' : ''}
            {hasZip ? ', and the ZIP archive' : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="hr-email">Send to</Label>
            <Input
              id="hr-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com"
              required
            />
            {!defaultEmail ? (
              <p className="mt-1 text-xs text-muted-foreground">
                No email on file for this homeowner — type one to send.
              </p>
            ) : null}
          </div>

          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Will include:</p>
            <ul className="mt-1 space-y-0.5">
              <li>• Permanent web link</li>
              <li>
                {hasPdf ? '• Branded PDF (download link)' : '• Branded PDF (not yet generated)'}
              </li>
              <li>
                {hasZip ? '• ZIP archive (download link)' : '• ZIP archive (not yet generated)'}
              </li>
            </ul>
          </div>

          {alreadySent && emailedTo ? (
            <p className="text-xs text-muted-foreground">
              Last sent to {emailedTo} on{' '}
              {new Intl.DateTimeFormat('en-CA', {
                timeZone: tz,
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              }).format(new Date(emailedAt!))}
              .
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={send} disabled={pending || !email.trim()}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
            {alreadySent ? 'Resend' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
