'use client';

/**
 * Confirms destructive deletion of a photo. Matches the Track A/C pattern
 * — shadcn AlertDialog wrapping a destructive button, toast on error.
 */

import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
import { deletePhotoAction } from '@/server/actions/photos';

export function DeletePhotoButton({
  photoId,
  size = 'icon',
  label,
}: {
  photoId: string;
  size?: 'sm' | 'icon';
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await deletePhotoAction(photoId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Photo deleted.');
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {size === 'icon' ? (
          <Button variant="destructive" size="icon" className="size-7" aria-label="Delete photo">
            <Trash2 className="size-3.5" />
          </Button>
        ) : (
          <Button variant="destructive" size="sm">
            <Trash2 className="size-3.5" />
            {label ?? 'Delete'}
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this photo?</AlertDialogTitle>
          <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending}
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
          >
            {pending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
