'use client';

/**
 * Delete-project confirmation. Soft-deletes the row via the server action
 * (deleted_at), so cost lines, photos, and worklog history remain for
 * audit. The action redirects to /projects on success.
 */

import { Trash2 } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { deleteProjectAction } from '@/server/actions/projects';

export function DeleteProjectButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [pending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result = await deleteProjectAction(projectId);
        if (result && 'ok' in result && !result.ok) {
          toast.error(result.error);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('NEXT_REDIRECT')) throw err;
        toast.error('Failed to delete project. Please try again.');
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Delete project"
          className="size-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {projectName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This hides the project from your lists. Cost lines, photos, change orders, and worklog
            history remain for your records.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending}
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
          >
            {pending ? 'Deleting…' : 'Delete project'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
