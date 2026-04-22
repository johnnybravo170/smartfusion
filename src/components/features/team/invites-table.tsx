'use client';

/**
 * Table showing all invites for the current tenant.
 * Owners can delete any unused invite.
 */

import { Loader2, Trash2 } from 'lucide-react';
import { useTransition } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { WorkerInviteRow } from '@/lib/db/queries/worker-invites';
import { deleteInviteAction } from '@/server/actions/team';

function inviteStatus(invite: WorkerInviteRow): {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
} {
  if (invite.revoked_at) return { label: 'Revoked', variant: 'destructive' };
  if (invite.used_at) return { label: 'Used', variant: 'secondary' };
  if (new Date(invite.expires_at) < new Date()) return { label: 'Expired', variant: 'outline' };
  return { label: 'Active', variant: 'default' };
}

function DeleteButton({ inviteId }: { inviteId: string }) {
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteInviteAction(inviteId);
      if (!result.ok) {
        toast.error(result.error ?? 'Failed to delete invite.');
        return;
      }
      toast.success('Invite deleted.');
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" disabled={pending} title="Delete invite">
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4 text-muted-foreground" />
          )}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete invite?</AlertDialogTitle>
          <AlertDialogDescription>
            This invite link will be permanently removed. You can create a new one anytime.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Props = {
  invites: WorkerInviteRow[];
};

export function InvitesTable({ invites }: Props) {
  if (invites.length === 0) {
    return <p className="text-sm text-muted-foreground">No invites yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Worker</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="w-[52px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {invites.map((invite) => {
          const status = inviteStatus(invite);
          const canDelete = status.label !== 'Used';

          return (
            <TableRow key={invite.id}>
              <TableCell className="text-sm">
                {invite.invited_name ?? (
                  <span className="text-muted-foreground">
                    {invite.invited_email ?? (
                      <span className="font-mono">{invite.code.slice(0, 8)}…</span>
                    )}
                  </span>
                )}
                {invite.invited_name && invite.invited_email ? (
                  <div className="text-xs text-muted-foreground">{invite.invited_email}</div>
                ) : null}
              </TableCell>
              <TableCell>
                <Badge variant={status.variant}>{status.label}</Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {new Date(invite.created_at).toLocaleDateString()}
              </TableCell>
              <TableCell>{canDelete ? <DeleteButton inviteId={invite.id} /> : null}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
