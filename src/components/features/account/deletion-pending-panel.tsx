'use client';

import { AlertCircle, Clock, RotateCcw } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { logoutAction } from '@/server/actions/auth';
import { abortTenantDeletionAction } from '@/server/actions/tenant-deletion';

export function DeletionPendingPanel({
  businessName,
  requestedAt,
  effectiveAt,
  isOwner,
}: {
  businessName: string;
  requestedAt: string;
  effectiveAt: string | null;
  isOwner: boolean;
}) {
  const [pending, startTransition] = useTransition();

  const daysRemaining = effectiveAt
    ? Math.max(0, Math.ceil((new Date(effectiveAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  function handleAbort() {
    startTransition(async () => {
      const result = await abortTenantDeletionAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Deletion cancelled. Welcome back.');
      window.location.href = '/dashboard';
    });
  }

  function handleLogout() {
    startTransition(async () => {
      await logoutAction();
    });
  }

  return (
    <Card className="w-full max-w-lg border-destructive/30">
      <CardHeader>
        <div className="flex items-start gap-3">
          <AlertCircle className="size-5 text-destructive" />
          <div>
            <CardTitle>Account scheduled for deletion</CardTitle>
            <CardDescription>
              <strong>{businessName}</strong> is queued for permanent removal.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3 text-sm">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">
              {daysRemaining !== null
                ? `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining`
                : 'Reversibility window active'}
            </p>
            <p className="text-muted-foreground">
              Requested on{' '}
              {new Date(requestedAt).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
              {effectiveAt
                ? `. Hard-deletes after ${new Date(effectiveAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}.`
                : '.'}
            </p>
          </div>
        </div>

        {isOwner ? (
          <>
            <p className="text-sm">
              You can cancel the deletion any time before the date above. After that, the data is
              permanently gone — we can't recover it.
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleAbort}
              disabled={pending}
            >
              <RotateCcw className="mr-1.5 size-4" />
              {pending ? 'Cancelling…' : 'Cancel deletion and restore access'}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only the workspace owner can cancel this deletion. Sign in as the owner if you have
            their credentials, or wait — after the date above, all members lose access permanently.
          </p>
        )}

        <button
          type="button"
          onClick={handleLogout}
          className="w-full text-center text-xs text-muted-foreground hover:underline"
          disabled={pending}
        >
          Sign out
        </button>
      </CardContent>
    </Card>
  );
}
