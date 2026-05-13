'use client';

import { AlertTriangle, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { requestTenantDeletionAction } from '@/server/actions/tenant-deletion';

export function DeleteAccountCard({
  businessName,
  isOwner,
}: {
  businessName: string;
  isOwner: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [confirmName, setConfirmName] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!isOwner) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Owner-only</CardTitle>
          <CardDescription>
            Only the workspace owner can delete the account. Ask them to do it from this page.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await requestTenantDeletionAction({
        confirmBusinessName: confirmName,
        reason: reason.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success('Account scheduled for deletion.');
      // Server has set tenants.deleted_at — reloading any dashboard route
      // will hit the /account/deletion-pending redirect.
      window.location.href = '/account/deletion-pending';
    });
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <div className="flex items-start gap-3">
          <AlertTriangle className="size-5 text-destructive" />
          <div>
            <CardTitle className="text-destructive">Delete this workspace</CardTitle>
            <CardDescription>
              This is irreversible after the 30-day reversibility window. Customers, projects,
              invoices, photos, and worklog history will be permanently removed.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">What happens next</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>You're signed out and redirected to a confirmation page.</li>
              <li>For 30 days, you can sign back in and abort the deletion.</li>
              <li>
                After 30 days, all data tied to <strong>{businessName}</strong> is hard-deleted. We
                can't recover it.
              </li>
              <li>Active subscriptions are cancelled when the request is filed.</li>
            </ul>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm-name">
              Type <span className="font-mono">{businessName}</span> to confirm
            </Label>
            <Input
              id="confirm-name"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={businessName}
              autoComplete="off"
              disabled={pending}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason (optional)</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Helps us improve. Anything you'd like us to know?"
              maxLength={1000}
              rows={3}
              disabled={pending}
            />
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="destructive"
            disabled={
              pending || confirmName.trim().toLowerCase() !== businessName.trim().toLowerCase()
            }
          >
            <Trash2 className="mr-1.5 size-4" />
            {pending ? 'Scheduling deletion…' : 'Schedule deletion'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
