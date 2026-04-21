'use client';

import { X } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { removeUnavailabilityAction } from '@/server/actions/worker-unavailability';

type Props = {
  workerProfileId: string;
  date: string;
  reasonLabel: string;
  reasonText: string | null;
};

export function UnavailabilityRow({ workerProfileId, date, reasonLabel, reasonText }: Props) {
  const [pending, startTransition] = useTransition();

  function handleRemove() {
    startTransition(async () => {
      const res = await removeUnavailabilityAction({
        worker_profile_id: workerProfileId,
        unavailable_date: date,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Removed.');
    });
  }

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
          Unavailable · {reasonLabel}
        </p>
        {reasonText ? (
          <p className="text-xs text-amber-900/80 dark:text-amber-200/80">{reasonText}</p>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon"
        disabled={pending}
        onClick={handleRemove}
        aria-label="Remove"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
