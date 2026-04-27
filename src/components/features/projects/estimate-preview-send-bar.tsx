'use client';

/**
 * Top-of-page send/back controls on the authed estimate preview.
 *
 * Two flows:
 *  - Customer has email → confirmation dialog → send.
 *  - Customer has no email → inline "add email" dialog → save email → send.
 */

import { ArrowLeft, Loader2, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { patchCustomerEmailAction } from '@/server/actions/customers';
import { sendEstimateForApprovalAction } from '@/server/actions/estimate-approval';

type Props = {
  projectId: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  totalFormatted: string;
  lineCount: number;
  alreadySent: boolean;
  /** Tenant default for quote-follow-up (Settings → Automations). */
  autoFollowupTenantDefault: boolean;
  /** Whether the tenant's plan unlocks the follow-up feature. */
  autoFollowupAvailable: boolean;
};

export function EstimatePreviewSendBar({
  projectId,
  customerId,
  customerName,
  customerEmail: initialEmail,
  totalFormatted,
  lineCount,
  alreadySent,
  autoFollowupTenantDefault,
  autoFollowupAvailable,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // Auto-followup checkbox — defaults to the tenant's setting, contractor can
  // override per-send. Disabled when the plan tier doesn't unlock the feature.
  const [autoFollowup, setAutoFollowup] = useState(
    autoFollowupAvailable ? autoFollowupTenantDefault : false,
  );

  // Email-capture state (only used when customer has no email).
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  // Track the live email so the confirm dialog shows it after the patch step.
  const [resolvedEmail, setResolvedEmail] = useState(initialEmail);

  const [note, setNote] = useState('');

  const canSend = lineCount > 0;
  const needsEmail = !resolvedEmail;

  const emailInputRef = useRef<HTMLInputElement>(null);

  function handleSend() {
    startTransition(async () => {
      const res = await sendEstimateForApprovalAction({
        projectId,
        note: note.trim() || null,
        autoFollowupOverride: autoFollowup,
      });
      if (res.ok) {
        toast.success('Estimate sent to customer');
        setOpen(false);
        router.push(`/projects/${projectId}?tab=estimate`);
      } else {
        toast.error(res.error);
      }
    });
  }

  async function handleSaveEmailAndSend() {
    setEmailError(null);
    const trimmed = email.trim();
    if (!trimmed?.includes('@')) {
      setEmailError('Please enter a valid email address.');
      emailInputRef.current?.focus();
      return;
    }
    startTransition(async () => {
      const patch = await patchCustomerEmailAction(customerId, trimmed);
      if (!patch.ok) {
        setEmailError(patch.error);
        return;
      }
      setResolvedEmail(trimmed);
      // Now send.
      const res = await sendEstimateForApprovalAction({
        projectId,
        note: note.trim() || null,
        autoFollowupOverride: autoFollowup,
      });
      if (res.ok) {
        toast.success('Estimate sent to customer');
        setOpen(false);
        router.push(`/projects/${projectId}?tab=estimate`);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="sticky top-0 z-10 -mx-4 mb-6 flex items-center justify-between gap-3 border-b bg-background/90 px-4 py-3 backdrop-blur">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push(`/projects/${projectId}?tab=estimate`)}
      >
        <ArrowLeft className="size-3.5" />
        Back to estimate
      </Button>

      <div className="flex items-center gap-3">
        {lineCount === 0 ? (
          <span className="text-xs text-amber-700">Add cost lines first.</span>
        ) : null}

        <AlertDialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) {
              setEmail('');
              setEmailError(null);
              setNote('');
            }
          }}
        >
          <AlertDialogTrigger asChild>
            <Button disabled={!canSend}>
              <Send className="size-3.5" />
              {alreadySent ? 'Resend to customer' : 'Send to customer'}
            </Button>
          </AlertDialogTrigger>

          {needsEmail ? (
            /* ── No email on file: collect it first ── */
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Add {customerName}'s email</AlertDialogTitle>
                <AlertDialogDescription>
                  We don't have an email address for {customerName} yet. Enter it below and we'll
                  save it to their profile and send the estimate.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="inline-email">Email address</Label>
                  <Input
                    id="inline-email"
                    ref={emailInputRef}
                    type="email"
                    autoFocus
                    placeholder="customer@example.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setEmailError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !pending) handleSaveEmailAndSend();
                    }}
                    disabled={pending}
                  />
                  {emailError ? <p className="text-xs text-destructive">{emailError}</p> : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="inline-note">
                    Personal note{' '}
                    <span className="text-muted-foreground font-normal">(optional)</span>
                  </Label>
                  <Textarea
                    id="inline-note"
                    placeholder="e.g. Great meeting you — let me know if you have any questions!"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={pending}
                    rows={3}
                  />
                </div>
                <AutoFollowupRow
                  checked={autoFollowup}
                  onCheckedChange={setAutoFollowup}
                  disabled={pending || !autoFollowupAvailable}
                  available={autoFollowupAvailable}
                />
              </div>

              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                <Button onClick={handleSaveEmailAndSend} disabled={pending || !email.trim()}>
                  {pending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  Save & send
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          ) : (
            /* ── Email known: normal confirm ── */
            <AlertDialogContent
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !pending) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {alreadySent ? 'Resend estimate?' : 'Send estimate?'}
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3 text-sm">
                    <div className="space-y-1">
                      <p>
                        Emailing <span className="font-medium text-foreground">{customerName}</span>{' '}
                        at <span className="font-medium text-foreground">{resolvedEmail}</span>.
                      </p>
                      <p>
                        Total <span className="font-medium text-foreground">{totalFormatted}</span>{' '}
                        across {lineCount} line {lineCount === 1 ? 'item' : 'items'}.
                      </p>
                      {alreadySent ? (
                        <p className="text-amber-700">
                          Already sent once — resending keeps the same approval link.
                        </p>
                      ) : null}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="confirm-note">
                        Personal note{' '}
                        <span className="font-normal text-muted-foreground">(optional)</span>
                      </Label>
                      <Textarea
                        id="confirm-note"
                        placeholder="e.g. Great meeting you — let me know if you have any questions!"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        disabled={pending}
                        rows={3}
                      />
                    </div>
                    <AutoFollowupRow
                      checked={autoFollowup}
                      onCheckedChange={setAutoFollowup}
                      disabled={pending || !autoFollowupAvailable}
                      available={autoFollowupAvailable}
                    />
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => handleSend()} disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  Send now
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          )}
        </AlertDialog>
      </div>
    </div>
  );
}

function AutoFollowupRow({
  checked,
  onCheckedChange,
  disabled,
  available,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled: boolean;
  available: boolean;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2.5">
      <Checkbox
        id="confirm-auto-followup"
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <Label
        htmlFor="confirm-auto-followup"
        className="flex-1 cursor-pointer text-xs font-normal text-muted-foreground"
      >
        Auto follow up if no response —{' '}
        <span className="text-foreground">SMS at 24h, email at 48h.</span>{' '}
        {!available ? (
          <span className="text-amber-700">Available on Growth plan and up.</span>
        ) : null}
      </Label>
    </div>
  );
}
